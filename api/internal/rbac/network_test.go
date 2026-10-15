package rbac

import (
	"net/http"
	"testing"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

func TestMiddleware_NetworkMemberGetsGrantedAccess(t *testing.T) {
	obj := newServerWithAnnotations(42, nil)
	ann := obj.GetAnnotations()
	ann[networkAnnotation] = "skyblock"
	obj.SetAnnotations(ann)
	obj.Object["spec"] = map[string]any{"templateRef": map[string]any{"name": "mc"}}
	fetch := &fakeFetcher{obj: obj}
	member := userWith(7, scope.DefaultCluster, "unrelated")
	member.Networks = map[string][]string{"skyblock": {"servers:console", "servers:write"}}
	outsider := userWith(8, scope.DefaultCluster, "unrelated")
	outsider.Networks = map[string][]string{"survival": {"servers:console", "servers:write"}}
	viewer := userWith(9, scope.DefaultCluster, "unrelated")
	viewer.Networks = map[string][]string{"skyblock": {}}
	users := map[int64]*auth.User{7: member, 8: outsider, 9: viewer}
	cases := []struct {
		name    string
		method  string
		path    string
		user    int64
		allowed bool
	}{
		{"member reads server", http.MethodGet, "/servers/alpha", 7, true},
		{"member starts server", http.MethodPost, "/servers/alpha:start", 7, true},
		{"member writes files", http.MethodPut, "/servers/alpha/files/content", 7, true},
		{"member opens console", http.MethodGet, "/ws/servers/alpha/console-pty", 7, true},
		{"member reads server template", http.MethodGet, "/templates/mc?server=alpha", 7, true},
		{"member cannot read another template", http.MethodGet, "/templates/other?server=alpha", 7, false},
		{"member cannot read template without server", http.MethodGet, "/templates/mc", 7, false},
		{"member cannot delete", http.MethodDelete, "/servers/alpha", 7, false},
		{"member cannot change network", http.MethodPut, "/servers/alpha:network", 7, false},
		{"member cannot transfer", http.MethodPost, "/servers/alpha:transfer", 7, false},
		{"viewer reads server", http.MethodGet, "/servers/alpha", 9, true},
		{"viewer reads server template", http.MethodGet, "/templates/mc?server=alpha", 9, true},
		{"viewer cannot start server", http.MethodPost, "/servers/alpha:start", 9, false},
		{"viewer cannot write files", http.MethodPut, "/servers/alpha/files/content", 9, false},
		{"viewer cannot open console", http.MethodGet, "/ws/servers/alpha/console-pty", 9, false},
		{"outsider cannot read", http.MethodGet, "/servers/alpha", 8, false},
		{"outsider cannot read server template", http.MethodGet, "/templates/mc?server=alpha", 8, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, called := serveThrough(t, fetch, users[c.user], c.method, c.path)
			if called != c.allowed {
				t.Fatalf("%s %s allowed=%v, want %v", c.method, c.path, called, c.allowed)
			}
		})
	}
}

func TestMiddleware_OwnerSetsNetwork(t *testing.T) {
	fetch := &fakeFetcher{obj: newServerWithAnnotations(42, nil)}
	owner := userWith(42, scope.DefaultCluster, "unrelated")
	if _, called := serveThrough(t, fetch, owner, http.MethodPut, "/servers/alpha:network"); !called {
		t.Fatal("owner must reach the :network handler")
	}
}

func TestRules_NetworksNeedUserPermissions(t *testing.T) {
	reader := userWith(1, scope.DefaultCluster, "*", "users:read")
	if !allow(reader, http.MethodGet, "/networks", scope.DefaultCluster, "") {
		t.Fatal("users:read must list networks")
	}
	if allow(reader, http.MethodPost, "/networks", scope.DefaultCluster, "") {
		t.Fatal("users:read must not create networks")
	}
	manager := userWith(1, scope.DefaultCluster, "*", "users:manage")
	if !allow(manager, http.MethodPut, "/networks/smp/members/3", scope.DefaultCluster, "") {
		t.Fatal("users:manage must edit network members")
	}
}
