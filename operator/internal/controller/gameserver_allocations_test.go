package controller

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

func TestReconcileAllocationsCreatesAndPrunes(t *testing.T) {
	ctx := context.Background()
	s := testScheme(t)
	gs := &gameplanev1alpha1.GameServer{
		ObjectMeta: metav1.ObjectMeta{Name: "smp", Namespace: "games", UID: "smp-uid"},
		Spec: gameplanev1alpha1.GameServerSpec{Networking: gameplanev1alpha1.GameServerNetworking{
			Allocations: []gameplanev1alpha1.PortAllocation{
				{Name: "voicechat", Port: 24455, Protocol: corev1.ProtocolUDP},
				{Name: "map", Port: 8100},
			},
		}},
	}
	cl := fake.NewClientBuilder().WithScheme(s).WithObjects(gs).Build()
	r := &GameServerReconciler{Client: cl, Scheme: s}

	if err := r.reconcileAllocations(ctx, gs); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	var voice corev1.Service
	if err := cl.Get(ctx, client.ObjectKey{Namespace: "games", Name: "smp-alloc-voicechat"}, &voice); err != nil {
		t.Fatalf("get voice service: %v", err)
	}
	if voice.Spec.Type != corev1.ServiceTypeLoadBalancer || voice.Spec.ExternalTrafficPolicy != corev1.ServiceExternalTrafficPolicyLocal {
		t.Fatalf("unexpected service spec: %+v", voice.Spec)
	}
	port := voice.Spec.Ports[0]
	if port.Port != 24455 || port.TargetPort.IntVal != 24455 || port.Protocol != corev1.ProtocolUDP {
		t.Fatalf("unexpected port: %+v", port)
	}
	if voice.Spec.Selector["app.kubernetes.io/instance"] != "smp" || !metav1.IsControlledBy(&voice, gs) {
		t.Fatalf("service not bound to the game pod: %+v", voice)
	}

	gs.Spec.Networking.Allocations = gs.Spec.Networking.Allocations[:1]
	if err := r.reconcileAllocations(ctx, gs); err != nil {
		t.Fatalf("reconcile after removal: %v", err)
	}
	var services corev1.ServiceList
	if err := cl.List(ctx, &services, client.MatchingLabels{allocationLabel: "smp"}); err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(services.Items) != 1 || services.Items[0].Name != "smp-alloc-voicechat" {
		t.Fatalf("expected only the voicechat service, got %d", len(services.Items))
	}

	voice.Status.LoadBalancer.Ingress = []corev1.LoadBalancerIngress{{IP: "203.0.113.7"}}
	if err := cl.Status().Update(ctx, &voice); err != nil {
		t.Fatalf("update status: %v", err)
	}
	endpoints := r.allocationEndpoints(ctx, gs)
	if len(endpoints) != 1 || endpoints[0].Host != "203.0.113.7" || endpoints[0].Port != 24455 {
		t.Fatalf("unexpected endpoints: %+v", endpoints)
	}

	if ports := allocationPolicyPorts(gs); len(ports) != 1 || *ports[0].Protocol != corev1.ProtocolUDP || ports[0].Port.IntVal != 24455 {
		t.Fatalf("unexpected policy ports: %+v", ports)
	}
}
