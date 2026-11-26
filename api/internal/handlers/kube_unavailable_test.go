package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clienttesting "k8s.io/client-go/testing"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/httperr"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

func failingServerList(err error) *kube.Client {
	k := fleetTestClient(fleetObject("GameServer", scope.DefaultNamespace, "alpha", "alpha-uid"))
	k.Dynamic.(*dynamicfake.FakeDynamicClient).PrependReactor("list", "gameservers", func(clienttesting.Action) (bool, runtime.Object, error) {
		return true, nil, err
	})
	return k
}

func problemRequest(t *testing.T, router http.Handler, user *auth.User, path string) (int, string) {
	t.Helper()
	req := httptest.NewRequestWithContext(auth.WithUser(t.Context(), user), http.MethodGet, path, nil)
	req.Header.Set("Accept", "application/problem+json")
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	var doc struct {
		MessageID string `json:"messageId"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &doc)
	return rr.Code, doc.MessageID
}

func TestKubeUnreachable(t *testing.T) {
	gr := kube.GVRs["servers"].GroupResource()
	for _, tc := range []struct {
		err  error
		want bool
	}{
		{nil, false},
		{&url.Error{Op: "Get", URL: "https://10.43.0.1", Err: errors.New("connection refused")}, true},
		{context.DeadlineExceeded, true},
		{apierrors.NewTimeoutError("slow", 1), true},
		{apierrors.NewServerTimeout(gr, "list", 1), true},
		{apierrors.NewServiceUnavailable("etcd"), true},
		{apierrors.NewInternalError(errors.New("etcdserver: request timed out")), true},
		{apierrors.NewForbidden(gr, "", errors.New("denied")), false},
		{apierrors.NewNotFound(gr, "x"), false},
	} {
		if got := kubeUnreachable(tc.err); got != tc.want {
			t.Errorf("kubeUnreachable(%v)=%v want %v", tc.err, got, tc.want)
		}
	}
}

func TestFleetServers_KubeUnreachableIs503(t *testing.T) {
	router := fleetRouter(clusterTestRegistry(failingServerList(&url.Error{Op: "Get", URL: "https://10.43.0.1", Err: context.DeadlineExceeded})))
	code, id := problemRequest(t, router, inventoryUser("local", "*", "servers:read"), "/fleet/servers")
	if code != http.StatusServiceUnavailable || id != httperr.IDKubernetesUnavailable {
		t.Fatalf("status=%d messageId=%q", code, id)
	}
}

func TestFleetServers_ForbiddenStaysPartial(t *testing.T) {
	router := fleetRouter(clusterTestRegistry(failingServerList(apierrors.NewForbidden(kube.GVRs["servers"].GroupResource(), "", errors.New("denied")))))
	got := decodeFleet[fleetResource](t, router, inventoryUser("local", "*", "servers:read"), "/fleet/servers")
	if !got.Partial || len(got.Items) != 0 {
		t.Fatalf("forbidden list=%+v", got)
	}
}

func TestServersList_KubeUnreachableIs503(t *testing.T) {
	router := mountResourcesRouter(failingServerList(apierrors.NewServerTimeout(kube.GVRs["servers"].GroupResource(), "list", 1)))
	code, id := problemRequest(t, router, inventoryUser("local", "*", "*"), "/servers/")
	if code != http.StatusServiceUnavailable || id != httperr.IDKubernetesUnavailable {
		t.Fatalf("status=%d messageId=%q", code, id)
	}
}
