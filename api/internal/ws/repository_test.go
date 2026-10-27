package ws

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/rbac"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

type repoFetcher struct{ repo *unstructured.Unstructured }

func (f repoFetcher) GetServer(context.Context, string, string, string) (*unstructured.Unstructured, error) {
	return nil, nil
}

func (f repoFetcher) GetRepository(context.Context, string, string, string) (*unstructured.Unstructured, error) {
	return f.repo, nil
}

func (repoFetcher) IDs() []string { return []string{scope.DefaultCluster} }

type agentSeen struct {
	path, token, author, body string
}

func TestRepoAgentProxy(t *testing.T) {
	var mu sync.Mutex
	var seen agentSeen
	reply := func(http.ResponseWriter) {}
	agent := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		mu.Lock()
		seen = agentSeen{path: req.URL.Path, token: req.Header.Get(gitTokenHeader), author: req.Header.Get(gitAuthorEmailHeader), body: string(body)}
		respond := reply
		mu.Unlock()
		respond(w)
	}))
	t.Cleanup(agent.Close)
	last := func() agentSeen {
		mu.Lock()
		defer mu.Unlock()
		return seen
	}
	setReply := func(respond func(http.ResponseWriter)) {
		mu.Lock()
		defer mu.Unlock()
		reply = respond
	}
	repo := &unstructured.Unstructured{Object: map[string]any{"metadata": map[string]any{"name": "site", "namespace": scope.DefaultNamespace, "uid": "u-1"}}}
	repo.SetAnnotations(map[string]string{"gameplane.local/owner-id": "1", "gameplane.local/collaborators": "2", rbac.RepoCollaboratorPermissionsAnnotation: `{"2":["repositories:write"]}`})
	creds := func(_ context.Context, user int64) (GitCredentials, bool) {
		return GitCredentials{Token: "ghp_secret", Name: "Alice", Email: "7+alice@users.noreply.github.com"}, user == 1 || user == 2
	}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			id := int64(1)
			if req.Header.Get("X-User") == "editor" {
				id = 2
			}
			next.ServeHTTP(w, req.WithContext(auth.WithUser(req.Context(), &auth.User{ID: id})))
		})
	})
	r.Use(rbac.Middleware(repoFetcher{repo}))
	(&RepoAgent{transport: testDirectTransport(agent), creds: creds}).Mount(r)
	do := func(user, method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequestWithContext(t.Context(), method, path, strings.NewReader(body))
		req.Header.Set("X-User", user)
		req.Header.Set(gitTokenHeader, "browser-injected")
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, req)
		return rr
	}

	setReply(func(w http.ResponseWriter) { _, _ = io.WriteString(w, `{"branch":"main"}`) })
	if rr := do("owner", "GET", "/repositories/site/git/status", ""); rr.Code != http.StatusOK || last().path != "/v1/targets/u-1/git/status" || last().token != "" {
		t.Fatalf("status = %d %+v", rr.Code, last())
	}
	if rr := do("owner", "POST", "/repositories/site/git/push", "{}"); rr.Code != http.StatusOK || last().token != "ghp_secret" || last().author != "" {
		t.Fatalf("push = %d %+v", rr.Code, last())
	}
	if rr := do("owner", "POST", "/repositories/site/git/commit", `{"summary":"x"}`); rr.Code != http.StatusOK || last().token != "" || last().author == "" || last().body != `{"summary":"x"}` {
		t.Fatalf("local commit = %d %+v", rr.Code, last())
	}
	if rr := do("owner", "POST", "/repositories/site/git/commit", `{"summary":"x","push":true}`); rr.Code != http.StatusOK || last().token != "ghp_secret" {
		t.Fatalf("commit and push = %d %+v", rr.Code, last())
	}
	mu.Lock()
	seen = agentSeen{}
	mu.Unlock()
	if rr := do("editor", "POST", "/repositories/site/git/commit", `{"summary":"x","push":true}`); rr.Code != http.StatusForbidden || last().path != "" {
		t.Fatalf("editor commit and push = %d %+v", rr.Code, last())
	}
	setReply(func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"code":"conflict","message":"rebase conflict","files":["a.txt"],"output":"CONFLICT"}`)
	})
	rr := do("owner", "POST", "/repositories/site/git/pull", "{}")
	if rr.Code != http.StatusConflict || !strings.Contains(rr.Body.String(), `"messageId":"server.repositories.conflict"`) || !strings.Contains(rr.Body.String(), `"files":["a.txt"]`) {
		t.Fatalf("conflict = %d %s", rr.Code, rr.Body)
	}
	setReply(func(w http.ResponseWriter) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, "git_dir\n")
	})
	if rr := do("owner", "GET", "/repositories/site/files/read", ""); rr.Code != http.StatusForbidden || !strings.Contains(rr.Body.String(), "server.repositories.git_dir") {
		t.Fatalf("git dir = %d %s", rr.Code, rr.Body)
	}
	if rr := do("owner", "GET", "/repositories/site/git/commits/not-a-sha", ""); rr.Code != http.StatusBadRequest {
		t.Fatalf("bad sha = %d", rr.Code)
	}
}
