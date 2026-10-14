package rbac

import (
	"net/http"
	"testing"

	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

func TestMiddleware_NetworkMemberGetsCollaboratorAccess(t *testing.T) {
	obj := newServerWithAnnotations(42, nil)
	ann := obj.GetAnnotations()
	ann[networkAnnotation] = "skyblock"
	obj.SetAnnotations(ann)
	fetch := &fakeFetcher{obj: obj}
	member := userWith(7, scope.DefaultCluster, "unrelated")
	member.Networks = []string{"skyblock"}
	outsider := userWith(8, scope.DefaultCluster, "unrelated")
	outsider.Networks = []string{"survival"}
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
		{"member cannot delete", http.MethodDelete, "/servers/alpha", 7, false},
		{"member cannot change network", http.MethodPut, "/servers/alpha:network", 7, false},
		{"member cannot transfer", http.MethodPost, "/servers/alpha:transfer", 7, false},
		{"outsider cannot read", http.MethodGet, "/servers/alpha", 8, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			u := member
			if c.user == 8 {
				u = outsider
			}
			_, called := serveThrough(t, fetch, u, c.method, c.path)
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
