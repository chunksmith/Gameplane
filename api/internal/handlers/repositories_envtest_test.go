//go:build envtest

package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	k8sfake "k8s.io/client-go/kubernetes/fake"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/db"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
	"github.com/GameplanePanel/gameplane/api/internal/rbac"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
	"github.com/GameplanePanel/gameplane/api/internal/ws"
)

func TestRepositoriesEnvtest(t *testing.T) {
	store, err := db.Open(context.Background(), "sqlite", "file:repositories?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"alice", "bob"} {
		if _, err := store.DB.ExecContext(t.Context(), `INSERT INTO users(username, role) VALUES (?, ?)`, name, "member"); err != nil {
			t.Fatal(err)
		}
	}
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer ghp_alice" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"login":"alice-gh","id":7,"name":"Alice"}`))
	}))
	t.Cleanup(github.Close)
	secrets := &kube.Client{Typed: k8sfake.NewClientset()}
	tokens := NewGitHubTokens(secrets, "gameplane")
	tokens.api = github.URL

	reg := kube.NewRegistry(scope.DefaultCluster)
	reg.Set(scope.DefaultCluster, kubeC)
	users := map[string]*auth.User{
		"alice": {ID: 1, Username: "alice", Perms: map[string]map[string]map[string]struct{}{scope.DefaultCluster: {"*": {rbac.RepoCreate: {}}}}},
		"bob":   {ID: 2, Username: "bob"},
	}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(auth.WithUser(req.Context(), users[req.Header.Get("X-User")])))
		})
	})
	r.Use(rbac.Middleware(reg))
	MountGitHubIntegration(r, tokens)
	MountRepositories(r, reg, store, ws.NewRepoAgent("", "", "", tokens.Credentials), tokens)
	do := func(user, method, path string, body any) *httptest.ResponseRecorder {
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		req := httptest.NewRequestWithContext(t.Context(), method, path, bytes.NewReader(raw))
		req.Header.Set("X-User", user)
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, req)
		return rr
	}

	name := uniqueResourceName("repo")
	create := map[string]string{"url": "https://github.com/chunksmith/lfln-bettermodel", "name": name}
	if rr := do("alice", "POST", "/repositories", create); rr.Code != http.StatusPreconditionRequired {
		t.Fatalf("create without token = %d %s", rr.Code, rr.Body)
	}
	if rr := do("alice", "PUT", "/integrations/github/token", map[string]string{"token": "ghp_wrong"}); rr.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid token = %d", rr.Code)
	}
	rr := do("alice", "PUT", "/integrations/github/token", map[string]string{"token": "ghp_alice"})
	if rr.Code != http.StatusOK || bytes.Contains(rr.Body.Bytes(), []byte("ghp_alice")) {
		t.Fatalf("put token = %d %s", rr.Code, rr.Body)
	}
	syncSecretData(t, secrets, "gameplane", tokens.name(1))
	if creds, ok := tokens.Credentials(t.Context(), 1); !ok || creds.Email != "7+alice-gh@users.noreply.github.com" || creds.Name != "Alice" {
		t.Fatalf("credentials = %+v", creds)
	}
	if rr := do("bob", "POST", "/repositories", create); rr.Code != http.StatusForbidden {
		t.Fatalf("create without permission = %d", rr.Code)
	}
	if rr := do("alice", "POST", "/repositories", map[string]string{"url": "https://gitlab.com/a/b", "name": name}); rr.Code != http.StatusBadRequest {
		t.Fatalf("foreign remote = %d", rr.Code)
	}
	if rr := do("alice", "POST", "/repositories", map[string]string{"url": create["url"], "name": strings.Repeat("a", 53)}); rr.Code != http.StatusBadRequest {
		t.Fatalf("long name = %d %s", rr.Code, rr.Body)
	}
	rr = do("alice", "POST", "/repositories", create)
	var repo repositoryDTO
	if rr.Code != http.StatusCreated || json.Unmarshal(rr.Body.Bytes(), &repo) != nil || repo.Phase != "Pending" || repo.Owner.ID != "1" || repo.Storage.Size != "2Gi" {
		t.Fatalf("create = %d %s", rr.Code, rr.Body)
	}
	path := "/repositories/" + name
	if rr := do("bob", "GET", path, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("stranger read = %d", rr.Code)
	}
	if rr := do("bob", "GET", "/repositories", nil); rr.Body.String() != "[]\n" {
		t.Fatalf("stranger list = %s", rr.Body)
	}
	if rr := do("alice", "PUT", path+"/collaborators/2", map[string]bool{"edit": true}); rr.Code != http.StatusNoContent {
		t.Fatalf("add collaborator = %d %s", rr.Code, rr.Body)
	}
	var access struct {
		IsCollaborator bool     `json:"isCollaborator"`
		Permissions    []string `json:"permissions"`
	}
	rr = do("bob", "GET", path+"/access", nil)
	if json.Unmarshal(rr.Body.Bytes(), &access) != nil || !access.IsCollaborator || len(access.Permissions) != 2 {
		t.Fatalf("collaborator access = %d %s", rr.Code, rr.Body)
	}
	if rr := do("bob", "DELETE", path, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("collaborator delete = %d", rr.Code)
	}
	if rr := do("bob", "POST", path+"/git/push", nil); rr.Code != http.StatusForbidden {
		t.Fatalf("editor push = %d", rr.Code)
	}
	if rr := do("bob", "POST", path+"/git/commit", map[string]any{"summary": "x", "push": true}); rr.Code != http.StatusForbidden {
		t.Fatalf("editor commit and push = %d", rr.Code)
	}
	if rr := do("bob", "POST", path+"/git/fetch", nil); rr.Code != http.StatusPreconditionRequired || !bytes.Contains(rr.Body.Bytes(), []byte("server.repositories.github_token_required")) {
		t.Fatalf("fetch without token = %d %s", rr.Code, rr.Body)
	}
	if rr := do("alice", "POST", path+"/git/fetch", nil); rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("fetch without mTLS = %d", rr.Code)
	}
	if rr := do("bob", "GET", "/repositories", nil); !bytes.Contains(rr.Body.Bytes(), []byte(`"collaborators":1`)) {
		t.Fatalf("collaborator list = %s", rr.Body)
	}
	if rr := do("alice", "GET", "/repositories?cluster=other", nil); rr.Code != http.StatusNotImplemented {
		t.Fatalf("remote cluster = %d", rr.Code)
	}
	if rr := do("alice", "DELETE", path+"/collaborators/"+strconv.Itoa(2), nil); rr.Code != http.StatusNoContent {
		t.Fatalf("remove collaborator = %d", rr.Code)
	}
	if rr := do("bob", "GET", path, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("removed collaborator read = %d", rr.Code)
	}
	if rr := do("alice", "POST", path+"/collaborators", map[string]any{"username": "nobody"}); rr.Code != http.StatusNotFound {
		t.Fatalf("unknown username = %d %s", rr.Code, rr.Body)
	}
	if rr := do("alice", "POST", path+"/collaborators", map[string]any{"username": "bob", "push": true}); rr.Code != http.StatusNoContent {
		t.Fatalf("add collaborator by username = %d %s", rr.Code, rr.Body)
	}
	if rr := do("bob", "GET", path+"/collaborators", nil); !bytes.Contains(rr.Body.Bytes(), []byte(`"username":"bob","read":true,"edit":false,"push":true`)) {
		t.Fatalf("collaborator by username = %d %s", rr.Code, rr.Body)
	}
	if rr := do("bob", "POST", path+"/collaborators", map[string]any{"username": "alice"}); rr.Code != http.StatusForbidden {
		t.Fatalf("collaborator adds collaborator = %d", rr.Code)
	}
	if rr := do("alice", "DELETE", path, nil); rr.Code != http.StatusNoContent {
		t.Fatalf("owner delete = %d %s", rr.Code, rr.Body)
	}
	if rr := do("alice", "DELETE", "/integrations/github/token", nil); rr.Code != http.StatusNoContent {
		t.Fatalf("delete token = %d", rr.Code)
	}
}
