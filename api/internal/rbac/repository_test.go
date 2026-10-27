package rbac

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

type fakeRepoFetcher struct {
	fakeServerFetcher
	repo *unstructured.Unstructured
}

func (f fakeRepoFetcher) GetRepository(context.Context, string, string, string) (*unstructured.Unstructured, error) {
	return f.repo, nil
}

func newRepo(annotations map[string]string) *unstructured.Unstructured {
	obj := &unstructured.Unstructured{Object: map[string]any{"metadata": map[string]any{"name": "site", "namespace": scope.DefaultNamespace, "uid": "repo-uid"}}}
	obj.SetAnnotations(annotations)
	return obj
}

func TestRepositoryMembership(t *testing.T) {
	repo := newRepo(map[string]string{
		ownerIDAnnotation:                     "1",
		collaboratorsAnnotation:               "2,3",
		RepoCollaboratorPermissionsAnnotation: `{"3":["repositories:write"]}`,
		networkAnnotation:                     "team",
	})
	stranger := func(perms ...string) *auth.User {
		u := clusterWide("custom", perms...)
		u.ID = 9
		return u
	}
	member := &auth.User{ID: 4, Networks: map[string][]string{"team": {"repositories:push", "servers:write"}}}
	cases := []struct {
		name         string
		user         *auth.User
		method, path string
		want         int
	}{
		{"owner pushes", &auth.User{ID: 1}, "POST", "/repositories/site/git/push", 204},
		{"owner deletes", &auth.User{ID: 1}, "DELETE", "/repositories/site", 204},
		{"collaborator reads", &auth.User{ID: 2}, "GET", "/repositories/site/git/status", 204},
		{"read-only collaborator cannot commit", &auth.User{ID: 2}, "POST", "/repositories/site/git/commit", 403},
		{"editor commits", &auth.User{ID: 3}, "POST", "/repositories/site/git/commit", 204},
		{"editor cannot push", &auth.User{ID: 3}, "POST", "/repositories/site/git/push", 403},
		{"editor cannot delete", &auth.User{ID: 3}, "DELETE", "/repositories/site", 403},
		{"editor cannot change collaborators", &auth.User{ID: 3}, "PUT", "/repositories/site/collaborators/9", 403},
		{"network member reads", member, "GET", "/repositories/site/files/list", 204},
		{"network member pushes", member, "POST", "/repositories/site/git/push", 204},
		{"network member cannot write files", member, "POST", "/repositories/site/files/write", 403},
		{"stranger is denied", &auth.User{ID: 9}, "GET", "/repositories/site", 403},
		{"manager reclones", stranger(RepoManage), "POST", "/repositories/site:reclone", 204},
		{"namespace reader cannot reclone", stranger(RepoRead, RepoWrite), "POST", "/repositories/site:reclone", 403},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := Middleware(fakeRepoFetcher{fakeServerFetcher{}, repo})(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if grant, ok := RepositoryGrantFrom(req.Context()); !ok || grant.Identity.UID != "repo-uid" {
					t.Errorf("grant not bound: %+v", grant)
				}
				w.WriteHeader(204)
			}))
			rr := httptest.NewRecorder()
			req := httptest.NewRequestWithContext(t.Context(), c.method, c.path, nil)
			h.ServeHTTP(rr, req.WithContext(auth.WithUser(req.Context(), c.user)))
			if rr.Code != c.want {
				t.Fatalf("code=%d want %d", rr.Code, c.want)
			}
		})
	}
}
