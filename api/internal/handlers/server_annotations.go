package handlers

import (
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// protectServerAnnotations reserves Gameplane's annotation domains for the
// controller and dedicated, authorized API operations. Generic CRUD must not
// inject wipe requests or erase lifecycle guards, even for an administrator.
// Description and the unused legacy grace-period hint remain user-editable,
// as do annotations in other domains. On creation there is no
// controller state to restore; the API stamps ownership after this function.
func protectServerAnnotations(desired, live *unstructured.Unstructured) {
	annotations := desired.GetAnnotations()
	if annotations == nil {
		annotations = map[string]string{}
	}
	for key := range annotations {
		if isGameplaneAnnotation(key) {
			delete(annotations, key)
		}
	}
	if live != nil {
		for key, value := range live.GetAnnotations() {
			if isGameplaneAnnotation(key) {
				annotations[key] = value
			}
		}
	}
	desired.SetAnnotations(annotations)
}

func isGameplaneAnnotation(key string) bool {
	switch key {
	case "gameplane.local/description", "gameplane.local/grace-period-seconds":
		// Settings edits description and removes the legacy grace-period hint
		// when migrating it to spec.stopGracePeriodSeconds.
		return false
	}
	domain, _, qualified := strings.Cut(key, "/")
	return qualified && (domain == "gameplane.local" || strings.HasSuffix(domain, ".gameplane.local"))
}

const serverSetStatefulSetLabel = "gameplane.local/server-set-statefulset"

var serverSetLabels = []string{"gameplane.local/server-set", serverSetStatefulSetLabel}

func protectServerOwnership(desired, live *unstructured.Unstructured) {
	labels := desired.GetLabels()
	for _, key := range serverSetLabels {
		delete(labels, key)
		if live != nil {
			if value, ok := live.GetLabels()[key]; ok {
				if labels == nil {
					labels = map[string]string{}
				}
				labels[key] = value
			}
		}
	}
	desired.SetLabels(labels)
	if live == nil {
		desired.SetOwnerReferences(nil)
		return
	}
	desired.SetOwnerReferences(live.GetOwnerReferences())
}
