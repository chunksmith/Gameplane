package controller

import (
	"context"
	"slices"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

func ordinalTestSet(replicas, start int32) *gameplanev1alpha1.GameServerSet {
	set := statefulSetTestSet(replicas)
	set.Spec.Ordinals = &appsv1.StatefulSetOrdinals{Start: start}
	return set
}

func TestSetReplicaNamesStartOrdinal(t *testing.T) {
	if names := setReplicaNames(statefulSetTestSet(2)); !slices.Equal(names, []string{"smp-0", "smp-1"}) {
		t.Errorf("default names = %v", names)
	}
	if names := setReplicaNames(ordinalTestSet(3, 1)); !slices.Equal(names, []string{"smp-1", "smp-2", "smp-3"}) {
		t.Errorf("start 1 names = %v", names)
	}
}

func TestRolloutPlanStartOrdinal(t *testing.T) {
	pods := map[string]*corev1.Pod{
		"set-1": readyPod("set-1", "old", time.Hour),
		"set-2": readyPod("set-2", "old", time.Hour),
		"set-3": readyPod("set-3", "new", time.Hour),
	}
	doomed, _ := rolloutPlan("set", 1, 3, pods, currentIs("new"), nil, 0)
	if len(doomed) != 1 || doomed[0].Name != "set-2" {
		t.Fatalf("doomed = %v, want set-2", doomed)
	}
	pods["set-2"] = readyPod("set-2", "new", time.Hour)
	pods["set-1"] = readyPod("set-1", "new", time.Hour)
	if doomed, requeue := rolloutPlan("set", 1, 3, pods, currentIs("new"), nil, 0); len(doomed) != 0 || requeue != 0 {
		t.Errorf("finished rollout doomed=%v requeue=%v", doomed, requeue)
	}
}

func TestReplicaPortsStartOrdinal(t *testing.T) {
	ctx := context.Background()
	set := ordinalTestSet(2, 1)
	set.Spec.ReplicaPorts = []gameplanev1alpha1.ReplicaPort{{Name: "voice", BasePort: 7200}}
	c := fake.NewClientBuilder().WithScheme(statefulSetTestScheme(t)).WithObjects(set).Build()
	r := &GameServerSetReconciler{Client: c, Scheme: c.Scheme(), Servers: &GameServerReconciler{}}
	if err := r.reconcileReplicaPorts(ctx, set); err != nil {
		t.Fatalf("reconcileReplicaPorts: %v", err)
	}
	var svc corev1.Service
	if err := c.Get(ctx, client.ObjectKey{Namespace: "games", Name: "smp-2-voice"}, &svc); err != nil {
		t.Fatalf("get smp-2-voice: %v", err)
	}
	if svc.Spec.Ports[0].Port != 7201 || svc.Spec.Selector[statefulSetPodNameLabel] != "smp-2" {
		t.Errorf("service = %+v", svc.Spec)
	}
	if err := c.Get(ctx, client.ObjectKey{Namespace: "games", Name: "smp-0-voice"}, &svc); err == nil {
		t.Error("service created for ordinal below start")
	}
}

func TestPlacementClaimsStartOrdinal(t *testing.T) {
	ctx := context.Background()
	set := ordinalTestSet(2, 1)
	set.Spec.Placement = []gameplanev1alpha1.ReplicaPlacement{{Ordinal: 0, Node: "a"}, {Ordinal: 2, Node: "b"}, {Ordinal: 3, Node: "c"}}
	carrier := serverSetCarrier(set, serverSetChildSpec(set))
	c := fake.NewClientBuilder().WithScheme(statefulSetTestScheme(t)).WithObjects(set).Build()
	r := &GameServerSetReconciler{Client: c, Scheme: c.Scheme(), Servers: &GameServerReconciler{}}
	if _, err := r.reconcilePlacementClaims(ctx, set, carrier, &gameplanev1alpha1.GameTemplate{}); err != nil {
		t.Fatalf("reconcilePlacementClaims: %v", err)
	}
	var pvcs corev1.PersistentVolumeClaimList
	if err := c.List(ctx, &pvcs); err != nil {
		t.Fatal(err)
	}
	if len(pvcs.Items) != 1 || pvcs.Items[0].Name != "data-smp-2" {
		t.Errorf("claims = %v, want only data-smp-2", pvcs.Items)
	}
}

func TestSetStatefulSetCopiesOrdinals(t *testing.T) {
	ctx := context.Background()
	set := ordinalTestSet(2, 1)
	carrier := serverSetCarrier(set, serverSetChildSpec(set))
	tmpl := &gameplanev1alpha1.GameTemplate{Spec: gameplanev1alpha1.GameTemplateSpec{Image: "paper:1"}}
	c := fake.NewClientBuilder().WithScheme(statefulSetTestScheme(t)).WithObjects(set).Build()
	r := &GameServerSetReconciler{Client: c, Scheme: c.Scheme(), Servers: &GameServerReconciler{}}
	if err := r.reconcileSetStatefulSet(ctx, set, carrier, tmpl, nil, &materializedConfig{}, true); err != nil {
		t.Fatalf("reconcileSetStatefulSet: %v", err)
	}
	var sts appsv1.StatefulSet
	if err := c.Get(ctx, client.ObjectKey{Namespace: "games", Name: "smp"}, &sts); err != nil {
		t.Fatal(err)
	}
	if sts.Spec.Ordinals == nil || sts.Spec.Ordinals.Start != 1 {
		t.Errorf("ordinals = %+v, want start 1", sts.Spec.Ordinals)
	}
	set.Spec.Ordinals = nil
	if err := r.reconcileSetStatefulSet(ctx, set, carrier, tmpl, nil, &materializedConfig{}, true); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(ctx, client.ObjectKey{Namespace: "games", Name: "smp"}, &sts); err != nil {
		t.Fatal(err)
	}
	if sts.Spec.Ordinals != nil {
		t.Errorf("ordinals = %+v, want nil without spec.ordinals", sts.Spec.Ordinals)
	}
}
