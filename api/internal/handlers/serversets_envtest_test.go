//go:build envtest

package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

func TestServerSets_CreateStampsOwner(t *testing.T) {
	name := uniqueResourceName("lobby")
	body := serverSetBody(name, map[string]any{"templateRef": map[string]any{"name": "minecraft"}})
	body["metadata"].(map[string]any)["annotations"] = map[string]any{"gameplane.local/owner-id": "999"}
	caller := operatorUser()

	rr := doAsUser(t, mountedR, caller, http.MethodPost, "/serversets", body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /serversets status = %d, want 201; body=%s", rr.Code, rr.Body.String())
	}
	t.Cleanup(func() { deleteServerSet(name) })

	got := getDynamic(t, gvrServerSets(), scope.DefaultNamespace, name)
	if owner, want := got.GetAnnotations()["gameplane.local/owner-id"], strconv.FormatInt(caller.ID, 10); owner != want {
		t.Errorf("owner-id = %q, want caller %q", owner, want)
	}
}

func TestServerSets_UpdateKeepsOwnerAnnotations(t *testing.T) {
	name := uniqueResourceName("lobby")
	caller := operatorUser()
	body := serverSetBody(name, map[string]any{"templateRef": map[string]any{"name": "minecraft"}})
	rr := doAsUser(t, mountedR, caller, http.MethodPost, "/serversets", body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /serversets status = %d, want 201; body=%s", rr.Code, rr.Body.String())
	}
	t.Cleanup(func() { deleteServerSet(name) })

	body["metadata"].(map[string]any)["annotations"] = map[string]any{"gameplane.local/owner-id": "999"}
	live := getDynamic(t, gvrServerSets(), scope.DefaultNamespace, name)
	body["metadata"].(map[string]any)["resourceVersion"] = live.GetResourceVersion()
	rr = doAsUser(t, mountedR, caller, http.MethodPut, "/serversets/"+name, body)
	if rr.Code != http.StatusOK {
		t.Fatalf("PUT /serversets/%s status = %d, want 200; body=%s", name, rr.Code, rr.Body.String())
	}

	got := getDynamic(t, gvrServerSets(), scope.DefaultNamespace, name)
	if owner, want := got.GetAnnotations()["gameplane.local/owner-id"], strconv.FormatInt(caller.ID, 10); owner != want {
		t.Errorf("owner-id = %q, want owner %q after forged PUT", owner, want)
	}
}

func TestServerSets_NonAdminImageRejected(t *testing.T) {
	name := uniqueResourceName("lobby")
	template := map[string]any{"templateRef": map[string]any{"name": "minecraft"}, "image": "evil:latest"}

	rr := doAsUser(t, mountedR, operatorUser(), http.MethodPost, "/serversets", serverSetBody(name, template))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("POST /serversets with spec.template.image status = %d, want 403; body=%s", rr.Code, rr.Body.String())
	}
}

func TestServerSets_TemplateRefImmutable(t *testing.T) {
	name := uniqueResourceName("lobby")
	body := serverSetBody(name, map[string]any{"templateRef": map[string]any{"name": "minecraft"}})
	resp := doJSON(t, http.MethodPost, "/serversets", body)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /serversets status = %d, want 201; body=%s", resp.StatusCode, readBody(t, resp))
	}
	t.Cleanup(func() { deleteServerSet(name) })

	body["spec"].(map[string]any)["template"] = map[string]any{"templateRef": map[string]any{"name": "valheim"}}
	resp = doJSON(t, http.MethodPut, "/serversets/"+name, body)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("PUT /serversets/%s (templateRef change) status = %d, want 409; body=%s", name, resp.StatusCode, readBody(t, resp))
	}
}

func TestServerSets_ListAndDelete(t *testing.T) {
	name := uniqueResourceName("lobby")
	body := serverSetBody(name, map[string]any{"templateRef": map[string]any{"name": "minecraft"}})
	resp := doJSON(t, http.MethodPost, "/serversets", body)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /serversets status = %d, want 201; body=%s", resp.StatusCode, readBody(t, resp))
	}
	t.Cleanup(func() { deleteServerSet(name) })

	resp = doJSON(t, http.MethodGet, "/serversets", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("LIST /serversets status = %d", resp.StatusCode)
	}
	var raw map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	resp.Body.Close()
	items, _ := raw["items"].([]any)
	found := false
	for _, it := range items {
		obj, _ := it.(map[string]any)
		md, _ := obj["metadata"].(map[string]any)
		if md["name"] == name {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("LIST /serversets missing the created set %q", name)
	}

	resp = doJSON(t, http.MethodDelete, "/serversets/"+name, nil)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /serversets/%s status = %d; body=%s", name, resp.StatusCode, readBody(t, resp))
	}
}

func TestServerSets_DeleteOwnerOnly(t *testing.T) {
	name := uniqueResourceName("lobby")
	owner := operatorUser()
	body := serverSetBody(name, map[string]any{"templateRef": map[string]any{"name": "minecraft"}})
	rr := doAsUser(t, mountedR, owner, http.MethodPost, "/serversets", body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /serversets status = %d, want 201; body=%s", rr.Code, rr.Body.String())
	}
	t.Cleanup(func() { deleteServerSet(name) })

	stranger := operatorUser()
	stranger.ID = 202
	rr = doAsUser(t, mountedR, stranger, http.MethodDelete, "/serversets/"+name, nil)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("non-owner DELETE /serversets/%s status = %d, want 403; body=%s", name, rr.Code, rr.Body.String())
	}
	getDynamic(t, gvrServerSets(), scope.DefaultNamespace, name)

	rr = doAsUser(t, mountedR, owner, http.MethodDelete, "/serversets/"+name, nil)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("owner DELETE /serversets/%s status = %d, want 204; body=%s", name, rr.Code, rr.Body.String())
	}
}

func TestServerSets_ScaleDownOwnerOnly(t *testing.T) {
	name := uniqueResourceName("lobby")
	owner := operatorUser()
	body := serverSetBody(name, map[string]any{"templateRef": map[string]any{"name": "minecraft"}})
	rr := doAsUser(t, mountedR, owner, http.MethodPost, "/serversets", body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /serversets status = %d, want 201; body=%s", rr.Code, rr.Body.String())
	}
	t.Cleanup(func() { deleteServerSet(name) })

	stranger := operatorUser()
	stranger.ID = 202
	body["spec"].(map[string]any)["replicas"] = 1
	rr = doAsUser(t, mountedR, stranger, http.MethodPut, "/serversets/"+name, body)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("non-owner scale-down PUT /serversets/%s status = %d, want 403; body=%s", name, rr.Code, rr.Body.String())
	}

	body["spec"].(map[string]any)["replicas"] = 3
	live := getDynamic(t, gvrServerSets(), scope.DefaultNamespace, name)
	body["metadata"].(map[string]any)["resourceVersion"] = live.GetResourceVersion()
	rr = doAsUser(t, mountedR, stranger, http.MethodPut, "/serversets/"+name, body)
	if rr.Code != http.StatusOK {
		t.Fatalf("non-owner scale-up PUT /serversets/%s status = %d, want 200; body=%s", name, rr.Code, rr.Body.String())
	}
}

func TestServerSets_RedactsPasswordConfig(t *testing.T) {
	templateName := uniqueResourceName("tmpl")
	gameTemplate := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "gameplane.local/v1alpha1",
		"kind":       "GameTemplate",
		"metadata":   map[string]any{"name": templateName},
		"spec": map[string]any{
			"displayName": "Test " + templateName,
			"game":        "test",
			"version":     "1",
			"image":       "ghcr.io/test/x:1",
			"configSchema": []any{
				map[string]any{"name": "MOTD", "type": "string"},
				map[string]any{"name": "RCON_PASSWORD", "type": "password"},
			},
		},
	}}
	if _, err := kubeC.Dynamic.Resource(gvrTemplates()).Create(context.Background(), gameTemplate, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create GameTemplate %s: %v", templateName, err)
	}
	t.Cleanup(func() {
		_ = kubeC.Dynamic.Resource(gvrTemplates()).Delete(context.Background(), templateName, metav1.DeleteOptions{})
	})

	name := uniqueResourceName("lobby")
	body := serverSetBody(name, map[string]any{
		"templateRef": map[string]any{"name": templateName},
		"config":      map[string]any{"MOTD": "hello", "RCON_PASSWORD": "s3cret"},
	})
	resp := doJSON(t, http.MethodPost, "/serversets", body)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /serversets status = %d, want 201; body=%s", resp.StatusCode, readBody(t, resp))
	}
	t.Cleanup(func() { deleteServerSet(name) })

	resp = doJSON(t, http.MethodGet, "/serversets/"+name, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /serversets/%s status = %d; body=%s", name, resp.StatusCode, readBody(t, resp))
	}
	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	resp.Body.Close()
	spec, _ := got["spec"].(map[string]any)
	setTemplate, _ := spec["template"].(map[string]any)
	config, _ := setTemplate["config"].(map[string]any)
	if config["RCON_PASSWORD"] != configRedactedMarker {
		t.Fatalf("GET RCON_PASSWORD = %v, want the redaction marker", config["RCON_PASSWORD"])
	}

	resp = doJSON(t, http.MethodPut, "/serversets/"+name, got)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT /serversets/%s status = %d; body=%s", name, resp.StatusCode, readBody(t, resp))
	}

	stored := getDynamic(t, gvrServerSets(), scope.DefaultNamespace, name)
	password, _, _ := unstructured.NestedString(stored.Object, "spec", "template", "config", "RCON_PASSWORD")
	if password != "s3cret" {
		t.Errorf("stored RCON_PASSWORD = %q, want the original secret", password)
	}
}

func serverSetBody(name string, template map[string]any) map[string]any {
	return map[string]any{
		"apiVersion": "gameplane.local/v1alpha1",
		"kind":       "GameServerSet",
		"metadata":   map[string]any{"name": name},
		"spec":       map[string]any{"replicas": 2, "template": template},
	}
}

func gvrServerSets() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "gameplane.local", Version: "v1alpha1", Resource: "gameserversets"}
}

func deleteServerSet(name string) {
	_ = kubeC.Dynamic.Resource(gvrServerSets()).Namespace(scope.DefaultNamespace).Delete(context.Background(), name, metav1.DeleteOptions{})
}
