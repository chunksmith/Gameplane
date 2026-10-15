package controller

import (
	"reflect"
	"slices"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

func TestServerSetChildSpec_ClearsCollidingNetworking(t *testing.T) {
	set := &gameplanev1alpha1.GameServerSet{
		ObjectMeta: metav1.ObjectMeta{Name: "lobby"},
		Spec: gameplanev1alpha1.GameServerSetSpec{
			Replicas: 2,
			Template: gameplanev1alpha1.GameServerSpec{
				Networking: gameplanev1alpha1.GameServerNetworking{
					Address:       "10.0.0.5",
					PortOverrides: []gameplanev1alpha1.PortOverride{{Name: "game", NodePort: 30001}},
				},
			},
		},
	}

	child := serverSetChildSpec(set)
	if child.Networking.Address != "" {
		t.Errorf("child address = %q, want empty", child.Networking.Address)
	}
	if len(child.Networking.PortOverrides) != 1 || child.Networking.PortOverrides[0].NodePort != 0 {
		t.Errorf("child port overrides = %+v, want one override with NodePort 0", child.Networking.PortOverrides)
	}
	if set.Spec.Template.Networking.Address != "10.0.0.5" {
		t.Errorf("set template address = %q, want 10.0.0.5 untouched", set.Spec.Template.Networking.Address)
	}
	if set.Spec.Template.Networking.PortOverrides[0].NodePort != 30001 {
		t.Errorf("set template NodePort = %d, want 30001 untouched", set.Spec.Template.Networking.PortOverrides[0].NodePort)
	}
}

func TestServerSetChildSpec_NodeAffinity(t *testing.T) {
	set := &gameplanev1alpha1.GameServerSet{
		ObjectMeta: metav1.ObjectMeta{Name: "lobby"},
		Spec: gameplanev1alpha1.GameServerSetSpec{
			Replicas: 2,
			Nodes:    []string{"node-a", "node-b"},
		},
	}

	required := serverSetChildSpec(set).Affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution
	if required == nil || len(required.NodeSelectorTerms) != 1 {
		t.Fatalf("required node affinity = %+v, want one term", required)
	}
	fields := required.NodeSelectorTerms[0].MatchFields
	if len(fields) != 1 || fields[0].Key != "metadata.name" || fields[0].Operator != corev1.NodeSelectorOpIn ||
		!slices.Equal(fields[0].Values, []string{"node-a", "node-b"}) {
		t.Errorf("match fields = %+v, want metadata.name In [node-a node-b]", fields)
	}

	preset := &corev1.NodeAffinity{RequiredDuringSchedulingIgnoredDuringExecution: &corev1.NodeSelector{
		NodeSelectorTerms: []corev1.NodeSelectorTerm{{
			MatchExpressions: []corev1.NodeSelectorRequirement{{Key: "zone", Operator: corev1.NodeSelectorOpIn, Values: []string{"a"}}},
		}},
	}}
	set = &gameplanev1alpha1.GameServerSet{
		ObjectMeta: metav1.ObjectMeta{Name: "lobby"},
		Spec: gameplanev1alpha1.GameServerSetSpec{
			Replicas: 2,
			Template: gameplanev1alpha1.GameServerSpec{Affinity: &corev1.Affinity{NodeAffinity: preset}},
		},
	}
	if got := serverSetChildSpec(set).Affinity.NodeAffinity; !reflect.DeepEqual(got, preset) {
		t.Errorf("node affinity = %+v, want template preset %+v", got, preset)
	}
}

func TestServerSetChildSpec_SpreadsReplicas(t *testing.T) {
	set := &gameplanev1alpha1.GameServerSet{
		ObjectMeta: metav1.ObjectMeta{Name: "lobby"},
		Spec: gameplanev1alpha1.GameServerSetSpec{
			Replicas: 3,
			Template: gameplanev1alpha1.GameServerSpec{
				Affinity: &corev1.Affinity{PodAntiAffinity: &corev1.PodAntiAffinity{
					PreferredDuringSchedulingIgnoredDuringExecution: []corev1.WeightedPodAffinityTerm{{
						Weight:          5,
						PodAffinityTerm: corev1.PodAffinityTerm{TopologyKey: "topology.kubernetes.io/zone"},
					}},
				}},
			},
		},
	}

	terms := serverSetChildSpec(set).Affinity.PodAntiAffinity.PreferredDuringSchedulingIgnoredDuringExecution
	if len(terms) != 2 {
		t.Fatalf("preferred anti-affinity terms = %d, want 2", len(terms))
	}
	if terms[0].Weight != 5 || terms[0].PodAffinityTerm.TopologyKey != "topology.kubernetes.io/zone" {
		t.Errorf("template term not kept first: %+v", terms[0])
	}
	spread := terms[1]
	if spread.Weight != 100 || spread.PodAffinityTerm.TopologyKey != "kubernetes.io/hostname" {
		t.Errorf("spread term = weight %d topology %q, want 100 kubernetes.io/hostname", spread.Weight, spread.PodAffinityTerm.TopologyKey)
	}
	if spread.PodAffinityTerm.LabelSelector == nil || spread.PodAffinityTerm.LabelSelector.MatchLabels[serverSetLabel] != "lobby" {
		t.Errorf("spread selector = %+v, want %s=lobby", spread.PodAffinityTerm.LabelSelector, serverSetLabel)
	}
}

func TestServerSetSpecHash(t *testing.T) {
	hashOf := func(image string) string {
		t.Helper()
		hash, err := serverSetSpecHash(&gameplanev1alpha1.GameServerSpec{Image: image})
		if err != nil {
			t.Fatalf("serverSetSpecHash: %v", err)
		}
		return hash
	}

	first := hashOf("example.com/lobby:1")
	if len(first) != 16 {
		t.Errorf("hash length = %d, want 16", len(first))
	}
	if same := hashOf("example.com/lobby:1"); same != first {
		t.Errorf("equal specs hashed to %q and %q", first, same)
	}
	if changed := hashOf("example.com/lobby:2"); changed == first {
		t.Errorf("image change kept hash %q", first)
	}
}

func TestIsEphemeral(t *testing.T) {
	if isEphemeral(&gameplanev1alpha1.GameServer{}) {
		t.Error("nil storage reported as ephemeral")
	}
	ephemeral := &gameplanev1alpha1.GameServer{
		Spec: gameplanev1alpha1.GameServerSpec{Storage: &gameplanev1alpha1.GameStorageSpec{Ephemeral: true}},
	}
	if !isEphemeral(ephemeral) {
		t.Error("ephemeral storage not reported as ephemeral")
	}
}
