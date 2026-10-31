package handlers

import (
	"context"
	"errors"
	"net/http"
	"reflect"

	"github.com/go-chi/chi/v5"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/httperr"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

func serverSetTemplate(obj *unstructured.Unstructured) *unstructured.Unstructured {
	spec, _, _ := unstructured.NestedFieldNoCopy(obj.Object, "spec", "template")
	return &unstructured.Unstructured{Object: map[string]any{"spec": spec}}
}

func redactServerSet(ctx context.Context, cache *configRuleCache, set *unstructured.Unstructured) {
	unstructured.RemoveNestedField(set.Object, "metadata", "annotations", "kubectl.kubernetes.io/last-applied-configuration")
	cache.redact(ctx, serverSetTemplate(set))
}

func serverSetReplicas(obj *unstructured.Unstructured) float64 {
	raw, _, _ := unstructured.NestedFieldNoCopy(obj.Object, "spec", "replicas")
	switch value := raw.(type) {
	case int64:
		return float64(value)
	case float64:
		return value
	}
	return 1
}

func serverSetDeleteOptions(w http.ResponseWriter, req *http.Request, k *kube.Client, gvr schema.GroupVersionResource, ns, name string) (metav1.DeleteOptions, bool) {
	set, err := k.Dynamic.Resource(gvr).Namespace(ns).Get(req.Context(), name, metav1.GetOptions{})
	if err != nil {
		httperr.Write(w, req, err)
		return metav1.DeleteOptions{}, false
	}
	if user := auth.UserFromContext(req.Context()); user != nil &&
		!user.Can("*", true, scope.RequestedCluster(req), ns) && !isServerOwner(set, user.ID) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return metav1.DeleteOptions{}, false
	}
	return metav1.DeleteOptions{Preconditions: objectDeletePreconditions(set)}, true
}

func validateServerSet(ctx context.Context, k *kube.Client, cl, ns string, desired, live *unstructured.Unstructured) error {
	var liveTemplate *unstructured.Unstructured
	if live != nil {
		liveTemplate = serverSetTemplate(live)
		if !serverSetExternalIPsEqual(desired, live) && !isClusterAdmin(ctx, cl, ns) {
			return errors.New("spec.replicaPorts externalIPs require admin privileges")
		}
	} else if len(serverSetExternalIPs(desired)) > 0 && !isClusterAdmin(ctx, cl, ns) {
		return errors.New("spec.replicaPorts externalIPs require admin privileges")
	}
	return validateAndProtectGameServer(ctx, k, cl, ns, desired.GetName(), serverSetTemplate(desired), liveTemplate)
}

func isClusterAdmin(ctx context.Context, cl, ns string) bool {
	u := auth.UserFromContext(ctx)
	return u != nil && (u.Role == "admin" || u.Can("*", false, cl, ns))
}

func serverSetExternalIPs(set *unstructured.Unstructured) map[string][]string {
	ports, _, _ := unstructured.NestedSlice(set.Object, "spec", "replicaPorts")
	out := map[string][]string{}
	for _, raw := range ports {
		port, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name, _, _ := unstructured.NestedString(port, "name")
		ips, _, _ := unstructured.NestedStringSlice(port, "externalIPs")
		if len(ips) > 0 {
			out[name] = ips
		}
	}
	return out
}

func serverSetExternalIPsEqual(desired, live *unstructured.Unstructured) bool {
	return reflect.DeepEqual(serverSetExternalIPs(desired), serverSetExternalIPs(live))
}

func protectServerSetCreate(w http.ResponseWriter, req *http.Request, k *kube.Client, ns string, obj *unstructured.Unstructured) bool {
	protectServerAnnotations(obj, nil)
	stampOwner(obj, req)
	stripRedactedConfig(serverSetTemplate(obj))
	if err := validateServerSet(req.Context(), k, scope.RequestedCluster(req), ns, obj, nil); err != nil {
		httperr.WriteCode(w, req, http.StatusForbidden, err)
		return false
	}
	return true
}

func protectServerSetUpdate(w http.ResponseWriter, req *http.Request, k *kube.Client, gvr schema.GroupVersionResource, obj *unstructured.Unstructured) bool {
	ns, ok := resolveNS(w, req)
	if !ok {
		return false
	}
	live, err := k.Dynamic.Resource(gvr).Namespace(ns).Get(req.Context(), chi.URLParam(req, "name"), metav1.GetOptions{})
	if err != nil {
		httperr.Write(w, req, err)
		return false
	}
	protectServerAnnotations(obj, live)
	restoreRedactedConfig(req.Context(), newConfigRuleCache(k), serverSetTemplate(obj), serverSetTemplate(live))
	if user := auth.UserFromContext(req.Context()); user != nil &&
		!user.Can("*", true, scope.RequestedCluster(req), ns) && !isServerOwner(live, user.ID) &&
		serverSetReplicas(obj) < serverSetReplicas(live) {
		httperr.WriteCode(w, req, http.StatusForbidden, errors.New("only the owner or an admin can remove replicas"))
		return false
	}
	if err := validateServerSet(req.Context(), k, scope.RequestedCluster(req), ns, obj, live); err != nil {
		code := http.StatusForbidden
		if errors.Is(err, errTemplateRefImmutable) {
			code = http.StatusConflict
		}
		httperr.WriteCode(w, req, code, err)
		return false
	}
	return true
}
