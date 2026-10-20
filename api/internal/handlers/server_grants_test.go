package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/GameplanePanel/gameplane/api/internal/kube"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

func newServerGrantsServer(t *testing.T) (*httptest.Server, int64) {
	t.Helper()
	store := newTestStore(t)
	reg := kube.NewRegistry(scope.DefaultCluster)
	reg.Set(scope.DefaultCluster, fakeCaptureClient(newCaptureServerObj("alpha", false)))
	r := chi.NewRouter()
	MountServerGrants(r, reg, store)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv, seedUser(t, store, "ayse", "member", "")
}

func TestServerGrants_Lifecycle(t *testing.T) {
	srv, userID := newServerGrantsServer(t)
	userQuery := strconv.FormatInt(userID, 10)
	grants := srv.URL + "/server-grants"
	body := map[string]any{
		"userId":    userID,
		"cluster":   scope.DefaultCluster,
		"namespace": scope.DefaultNamespace,
		"server":    "alpha",
	}
	withPermissions := func(permissions ...string) map[string]any {
		b := map[string]any{}
		for k, v := range body {
			b[k] = v
		}
		b["permissions"] = permissions
		return b
	}

	if status, _ := doReq(t, "PUT", grants, withPermissions("servers:delete")); status != 400 {
		t.Fatalf("invalid permission want 400 got %d", status)
	}
	missingUser := withPermissions("servers:console")
	missingUser["userId"] = int64(999)
	if status, _ := doReq(t, "PUT", grants, missingUser); status != 404 {
		t.Fatalf("unknown user want 404 got %d", status)
	}

	status, raw := doReq(t, "GET", grants+"?userId="+userQuery, nil)
	if status != 200 || strings.TrimSpace(string(raw)) != "[]" {
		t.Fatalf("empty list want 200 [] got %d %s", status, raw)
	}

	if status, raw := doReq(t, "PUT", grants, withPermissions("servers:write", "servers:console", "servers:write")); status != 204 {
		t.Fatalf("put want 204 got %d body=%s", status, raw)
	}
	status, raw = doReq(t, "GET", grants+"?userId="+userQuery, nil)
	var listed []serverGrantDTO
	if err := json.Unmarshal(raw, &listed); err != nil || status != 200 {
		t.Fatalf("list want 200 got %d err=%v body=%s", status, err, raw)
	}
	if len(listed) != 1 || listed[0].Server != "alpha" || !slices.Equal(listed[0].Permissions, []string{"servers:console", "servers:write"}) {
		t.Fatalf("list = %+v", listed)
	}

	deletePath := grants + "?userId=" + userQuery + "&cluster=" + scope.DefaultCluster + "&namespace=" + scope.DefaultNamespace + "&server=alpha"
	if status, _ := doReq(t, "DELETE", deletePath, nil); status != 204 {
		t.Fatalf("delete want 204 got %d", status)
	}
	if status, _ := doReq(t, "DELETE", deletePath, nil); status != 404 {
		t.Fatalf("repeat delete want 404 got %d", status)
	}
}
