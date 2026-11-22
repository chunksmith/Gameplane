package controller

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
	"github.com/GameplanePanel/gameplane/operator/internal/edge"
)

const servingCondition corev1.PodConditionType = "gameplane.local/serving"

type servingInputs struct {
	current          func(*corev1.Pod) bool
	held             map[string]bool
	doomed           []*corev1.Pod
	updatedAvailable bool
	minReady         time.Duration
}

func (inputs servingInputs) serving(pod *corev1.Pod) bool {
	switch {
	case pod == nil || pod.DeletionTimestamp != nil || inputs.held[pod.Name] || slices.Contains(inputs.doomed, pod):
		return false
	case inputs.current(pod):
		return true
	default:
		return !inputs.updatedAvailable
	}
}

func (inputs servingInputs) edgeEnabled(pod *corev1.Pod, disableOn gameplanev1alpha1.EdgeDisableOn) (enabled, decided bool) {
	stop := disableOn == gameplanev1alpha1.EdgeDisableOnStop
	switch {
	case pod == nil:
		return false, true
	case pod.DeletionTimestamp != nil && stop:
		return false, false
	}
	available, _ := conditionAvailable(pod, corev1.ContainersReady, inputs.minReady)
	if stop {
		return available && !inputs.held[pod.Name], true
	}
	return available && inputs.serving(pod), true
}

func (r *GameServerSetReconciler) reconcileServing(
	ctx context.Context, set *gameplanev1alpha1.GameServerSet, pods map[string]*corev1.Pod, inputs servingInputs,
) error {
	rollout := set.Spec.Rollout
	if rollout == nil {
		return nil
	}
	if rollout.ServingGate {
		for _, pod := range pods {
			if pod.DeletionTimestamp != nil {
				continue
			}
			if err := r.setServingCondition(ctx, pod, inputs.serving(pod)); err != nil {
				return err
			}
		}
	}
	for _, spec := range rollout.Edges {
		provider, err := r.edgeProvider(ctx, set.Namespace, spec)
		if err != nil {
			return err
		}
		for key, backend := range spec.Backends {
			ordinal, err := strconv.Atoi(key)
			if err != nil {
				return fmt.Errorf("edge %s: backend key %q is not an ordinal", spec.Name, key)
			}
			enabled, decided := inputs.edgeEnabled(pods[fmt.Sprintf("%s-%d", set.Name, ordinal)], spec.DisableOn)
			if !decided {
				continue
			}
			if err := provider.SetEnabled(ctx, backend, enabled); err != nil {
				return fmt.Errorf("edge %s ordinal %d: %w", spec.Name, ordinal, err)
			}
		}
	}
	return nil
}

func (r *GameServerSetReconciler) setServingCondition(ctx context.Context, pod *corev1.Pod, serving bool) error {
	status := corev1.ConditionFalse
	if serving {
		status = corev1.ConditionTrue
	}
	index := slices.IndexFunc(pod.Status.Conditions, func(condition corev1.PodCondition) bool {
		return condition.Type == servingCondition
	})
	if index >= 0 && pod.Status.Conditions[index].Status == status {
		return nil
	}
	patched := pod.DeepCopy()
	condition := corev1.PodCondition{Type: servingCondition, Status: status, LastTransitionTime: metav1.Now(), Reason: "Rollout"}
	if index >= 0 {
		patched.Status.Conditions[index] = condition
	} else {
		patched.Status.Conditions = append(patched.Status.Conditions, condition)
	}
	if err := r.Status().Patch(ctx, patched, client.StrategicMergeFrom(pod)); client.IgnoreNotFound(err) != nil {
		return fmt.Errorf("set serving on %s: %w", pod.Name, err)
	}
	return nil
}

func (r *GameServerSetReconciler) edgeProvider(
	ctx context.Context, namespace string, spec gameplanev1alpha1.SetEdge,
) (edge.Provider, error) {
	if r.Edges == nil {
		return nil, errors.New("rollout edges need an edge registry")
	}
	var secret corev1.Secret
	if err := r.Get(ctx, types.NamespacedName{Namespace: namespace, Name: spec.SecretRef.Name}, &secret); err != nil {
		return nil, fmt.Errorf("edge %s secret: %w", spec.Name, err)
	}
	token := string(secret.Data["token"])
	if token == "" {
		return nil, fmt.Errorf("edge %s: secret %s has no token", spec.Name, spec.SecretRef.Name)
	}
	provider, err := r.Edges.Get(spec.Provider, token, spec.Config)
	if err != nil {
		return nil, fmt.Errorf("edge %s: %w", spec.Name, err)
	}
	return provider, nil
}

func conditionAvailable(pod *corev1.Pod, kind corev1.PodConditionType, minReady time.Duration) (bool, time.Duration) {
	for _, condition := range pod.Status.Conditions {
		if condition.Type != kind || condition.Status != corev1.ConditionTrue {
			continue
		}
		if remaining := minReady - time.Since(condition.LastTransitionTime.Time); remaining > 0 {
			return false, remaining
		}
		return true, 0
	}
	return false, 0
}
