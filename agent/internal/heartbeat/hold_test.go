package heartbeat

import (
	"context"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

func TestAwaitReleaseWaitsWhileSuspended(t *testing.T) {
	server := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "gameplane.local/v1alpha1",
		"kind":       "GameServer",
		"metadata":   map[string]any{"name": "smp-1", "namespace": "games"},
		"spec":       map[string]any{"suspend": true},
	}}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{gvr: "GameServerList"}, server)
	servers := dyn.Resource(gvr).Namespace("games")

	held, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := awaitRelease(held, servers, "smp-1", 10*time.Millisecond); err == nil {
		t.Fatal("suspended server released")
	}
	if err := awaitRelease(held, servers, "missing", 10*time.Millisecond); err == nil {
		t.Fatal("missing server released")
	}

	_ = unstructured.SetNestedField(server.Object, false, "spec", "suspend")
	server.SetAnnotations(map[string]string{"gameplane.local/wipe-owner": "token"})
	if _, err := servers.Update(context.Background(), server, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	guarded, cancelGuarded := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancelGuarded()
	if err := awaitRelease(guarded, servers, "smp-1", 10*time.Millisecond); err == nil {
		t.Fatal("server under a wipe guard released")
	}
	server.SetAnnotations(nil)
	if _, err := servers.Update(context.Background(), server, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := awaitRelease(context.Background(), servers, "smp-1", 10*time.Millisecond); err != nil {
		t.Fatalf("released server still held: %v", err)
	}
}
