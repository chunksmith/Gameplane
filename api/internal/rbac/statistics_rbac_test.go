package rbac

import (
	"net/http"
	"testing"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

func TestAllow_StatisticsRequiresClusterRead(t *testing.T) {
	store := migratedStore(t)
	viewer := userForRole(t, store, RoleViewer)
	serversOnly := &auth.User{Role: RoleMember, Perms: map[string]map[string]map[string]struct{}{
		scope.DefaultCluster: {"*": {"servers:read": {}}},
	}}
	for _, path := range []string{"/statistics/live", "/statistics/history", "/statistics/nodes/n1"} {
		if !allow(viewer, http.MethodGet, path, scope.DefaultCluster, scope.DefaultNamespace) {
			t.Errorf("viewer denied GET %s", path)
		}
		if allow(serversOnly, http.MethodGet, path, scope.DefaultCluster, scope.DefaultNamespace) {
			t.Errorf("user without cluster:read allowed GET %s", path)
		}
	}
}
