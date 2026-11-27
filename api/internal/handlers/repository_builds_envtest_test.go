//go:build envtest

package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/go-chi/chi/v5"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
	"github.com/GameplanePanel/gameplane/api/internal/rbac"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

func TestRepositoryBuildsEnvtest(t *testing.T) {
	ns := scope.DefaultNamespace
	name := uniqueResourceName("builds")
	repo := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "gameplane.local/v1alpha1", "kind": "Repository",
		"metadata": map[string]any{"name": name, "namespace": ns, "annotations": map[string]any{ownerIDAnnotation: "1", ownerAnnotation: "alice"}},
		"spec":     map[string]any{"url": "https://github.com/chunksmith/lfln-bettermodel", "storage": map[string]any{"size": "2Gi"}},
	}}
	if _, err := kubeC.Dynamic.Resource(kube.GVRRepository).Namespace(ns).Create(t.Context(), repo, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	reg := kube.NewRegistry(scope.DefaultCluster)
	reg.Set(scope.DefaultCluster, kubeC)
	users := map[string]*auth.User{
		"alice": {ID: 1, Username: "alice"},
		"bob":   {ID: 2, Username: "bob"},
	}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(auth.WithUser(req.Context(), users[req.Header.Get("X-User")])))
		})
	})
	r.Use(rbac.Middleware(reg))
	MountRepositoryBuilds(r, reg, r, nil)
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
	base := "/repositories/" + name + "/builds"

	if rr := do("bob", "GET", base, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("stranger list = %d", rr.Code)
	}
	rr := do("alice", "GET", base, nil)
	var list struct {
		Builds []json.RawMessage `json:"builds"`
		Keep   int               `json:"keep"`
	}
	if rr.Code != http.StatusOK || json.Unmarshal(rr.Body.Bytes(), &list) != nil || len(list.Builds) != 0 || list.Keep != buildKeep {
		t.Fatalf("list = %d %s", rr.Code, rr.Body)
	}
	if rr := do("alice", "POST", base, map[string]string{}); rr.Code != http.StatusConflict || !bytes.Contains(rr.Body.Bytes(), []byte("builds.not_ready")) {
		t.Fatalf("start without an agent = %d %s", rr.Code, rr.Body)
	}

	seedBuild := func(number int, phase string) {
		obj := &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "gameplane.local/v1alpha1", "kind": "RepositoryBuild",
			"metadata": map[string]any{
				"name": name + "-build-" + strconv.Itoa(number), "namespace": ns,
				"labels": map[string]any{buildLabelRepository: name, buildLabelNumber: strconv.Itoa(number)},
			},
			"spec": map[string]any{"repositoryRef": name, "tool": "maven", "jdk": int64(21), "publish": true},
		}}
		created, err := kubeC.Dynamic.Resource(kube.GVRRepositoryBuild).Namespace(ns).Create(t.Context(), obj, metav1.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if phase == "" {
			return
		}
		created.Object["status"] = map[string]any{
			"phase":     phase,
			"artifacts": []any{map[string]any{"path": "target/a.jar", "size": int64(3), "sha256": "00", "shaded": false}},
		}
		if _, err := kubeC.Dynamic.Resource(kube.GVRRepositoryBuild).Namespace(ns).UpdateStatus(t.Context(), created, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	seedBuild(1, "")
	if rr := do("alice", "POST", base, map[string]string{}); rr.Code != http.StatusConflict || !bytes.Contains(rr.Body.Bytes(), []byte("builds.active")) {
		t.Fatalf("start while active = %d %s", rr.Code, rr.Body)
	}
	seedBuild(2, "Succeeded")
	if rr := do("alice", "GET", base+"/2", nil); rr.Code != http.StatusOK {
		t.Fatalf("get build = %d %s", rr.Code, rr.Body)
	}
	deploy := map[string]any{"artifact": "target/a.jar", "targets": []map[string]string{{"server": "lobby", "namespace": ns}}}
	if rr := do("alice", "POST", base+"/2/deploy", deploy); rr.Code != http.StatusForbidden || !bytes.Contains(rr.Body.Bytes(), []byte("builds.target_forbidden")) {
		t.Fatalf("deploy to a forbidden target = %d %s", rr.Code, rr.Body)
	}
	if rr := do("alice", "POST", base+"/2/deploy", map[string]any{"artifact": "target/missing.jar", "targets": []map[string]string{{"server": "lobby"}}}); rr.Code != http.StatusNotFound {
		t.Fatalf("unknown artifact = %d %s", rr.Code, rr.Body)
	}
	if rr := do("bob", "DELETE", base+"/2", nil); rr.Code != http.StatusForbidden {
		t.Fatalf("stranger delete = %d", rr.Code)
	}
	if rr := do("alice", "DELETE", base+"/1", nil); rr.Code != http.StatusNoContent {
		t.Fatalf("delete = %d %s", rr.Code, rr.Body)
	}
	if rr := do("alice", "POST", base+":clear-cache", nil); rr.Code != http.StatusAccepted {
		t.Fatalf("clear cache = %d %s", rr.Code, rr.Body)
	}
}
