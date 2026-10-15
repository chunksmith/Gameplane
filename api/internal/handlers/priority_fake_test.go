package handlers

import (
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/GameplanePanel/gameplane/api/internal/kube"
)

func TestLifecycle_Priority(t *testing.T) {
	k := fakeKubeClient(newServerObj("gameplane-games", "alpha"))
	r := mountLifecycleRouter(k)

	for _, body := range []any{nil, map[string]any{}, map[string]any{"priority": 1.5}, map[string]any{"priority": "7"}} {
		if rr := do(t, r, "PUT", "/servers/alpha:priority", body); rr.Code != 400 {
			t.Errorf("body %v: got %d, want 400", body, rr.Code)
		}
	}
	if rr := do(t, r, "PUT", "/servers/missing:priority", map[string]any{"priority": 1}); rr.Code != 404 {
		t.Errorf("missing server: got %d, want 404", rr.Code)
	}

	rr := do(t, r, "PUT", "/servers/alpha:priority", map[string]any{"priority": -2048})
	if rr.Code != 204 {
		t.Fatalf("got %d %s", rr.Code, rr.Body)
	}
	obj, err := k.Dynamic.Resource(kube.GVRs["servers"]).
		Namespace("gameplane-games").Get(t.Context(), "alpha", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got := obj.GetAnnotations()[priorityAnnotation]; got != "-2048" {
		t.Errorf("priority annotation = %q, want -2048", got)
	}
}
