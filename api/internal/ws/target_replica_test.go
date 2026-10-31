package ws

import (
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestReplicaOwner(t *testing.T) {
	controller := true
	gs := &unstructured.Unstructured{Object: map[string]any{}}
	gs.SetLabels(map[string]string{serverSetStatefulSetLabel: "smp"})
	gs.SetOwnerReferences([]metav1.OwnerReference{{
		APIVersion: "gameplane.local/v1alpha1", Kind: "GameServerSet", Name: "smp", UID: "set-uid", Controller: &controller,
	}})
	if set, uid, ok := replicaOwner(gs); !ok || set != "smp" || uid != "set-uid" {
		t.Errorf("replicaOwner = %q %q %v", set, uid, ok)
	}
	gs.SetLabels(map[string]string{serverSetStatefulSetLabel: "other"})
	if _, _, ok := replicaOwner(gs); ok {
		t.Error("label naming another set accepted")
	}
	gs.SetLabels(nil)
	if _, _, ok := replicaOwner(gs); ok {
		t.Error("server without the StatefulSet label accepted")
	}
	if got := serverPodName(t.Context(), nil, "games", "lobby"); got != "lobby-0" {
		t.Errorf("serverPodName without a client = %q, want lobby-0", got)
	}
}
