package controller

import (
	"context"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

const (
	StopModeAnnotation = "gameplane.local/stop-mode"
	stopModeSignal     = "signal"
)

func signalStopMode(gs *gameplanev1alpha1.GameServer, tmpl *gameplanev1alpha1.GameTemplate) bool {
	return gs.Annotations[StopModeAnnotation] == stopModeSignal || tmpl.Annotations[StopModeAnnotation] == stopModeSignal
}

func (r *GameServerReconciler) signalStop(ctx context.Context, gs *gameplanev1alpha1.GameServer) error {
	var pod corev1.Pod
	if err := r.Get(ctx, types.NamespacedName{Namespace: gs.Namespace, Name: gamePodName(gs)}, &pod); err != nil {
		return client.IgnoreNotFound(err)
	}
	if pod.DeletionTimestamp != nil {
		return nil
	}
	grace := int64(defaultStopGracePeriod / time.Second)
	if gs.Spec.StopGracePeriodSeconds != nil {
		grace = int64(*gs.Spec.StopGracePeriodSeconds)
	}
	uid := pod.UID
	if err := r.Delete(ctx, &pod, client.GracePeriodSeconds(grace), client.Preconditions{UID: &uid}); client.IgnoreNotFound(err) != nil {
		return fmt.Errorf("signal stop pod: %w", err)
	}
	return nil
}
