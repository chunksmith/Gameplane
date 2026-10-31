package controller

import (
	"context"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

const (
	serverSetStatefulSetLabel = "gameplane.local/server-set-statefulset"
	statefulSetPodNameLabel   = "statefulset.kubernetes.io/pod-name"
)

func statefulSetReplica(gs *gameplanev1alpha1.GameServer) bool {
	return gs.Labels[serverSetStatefulSetLabel] != ""
}

func gamePodName(gs *gameplanev1alpha1.GameServer) string {
	if statefulSetReplica(gs) {
		return gs.Name
	}
	return gs.Name + "-0"
}

func dataClaimName(gs *gameplanev1alpha1.GameServer) string {
	if statefulSetReplica(gs) {
		return "data-" + gs.Name
	}
	return gs.Name + "-data"
}

func gamePodSelector(gs *gameplanev1alpha1.GameServer) map[string]string {
	if set := gs.Labels[serverSetStatefulSetLabel]; set != "" {
		return map[string]string{
			"app.kubernetes.io/name":  "gameplane-game",
			serverSetStatefulSetLabel: set,
			statefulSetPodNameLabel:   gs.Name,
		}
	}
	return map[string]string{
		"app.kubernetes.io/name":     "gameplane-game",
		"app.kubernetes.io/instance": gs.Name,
	}
}

func (r *GameServerReconciler) workloadState(ctx context.Context, gs *gameplanev1alpha1.GameServer) (exists, ready bool, err error) {
	if statefulSetReplica(gs) {
		var pod corev1.Pod
		err := r.Get(ctx, types.NamespacedName{Namespace: gs.Namespace, Name: gamePodName(gs)}, &pod)
		if apierrors.IsNotFound(err) {
			return false, false, nil
		}
		if err != nil {
			return false, false, fmt.Errorf("get pod %s: %w", gamePodName(gs), err)
		}
		return true, podReady(&pod), nil
	}
	var ss appsv1.StatefulSet
	err = r.Get(ctx, types.NamespacedName{Namespace: gs.Namespace, Name: gs.Name}, &ss)
	if apierrors.IsNotFound(err) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	return true, ss.Status.ReadyReplicas > 0, nil
}
