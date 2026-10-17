package controller

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

const (
	KillRequestedAnnotation = "gameplane.local/kill-requested"
	KillCompletedAnnotation = "gameplane.local/kill-completed"
)

func (r *GameServerReconciler) forceKill(ctx context.Context, gs *gameplanev1alpha1.GameServer) error {
	if !tokenPending(gs, KillRequestedAnnotation, KillCompletedAnnotation) {
		return nil
	}
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: gs.Namespace, Name: gs.Name + "-0"}}
	if err := r.Delete(ctx, pod, client.GracePeriodSeconds(1)); client.IgnoreNotFound(err) != nil {
		return fmt.Errorf("force kill pod: %w", err)
	}
	base := gs.DeepCopy()
	gs.Annotations[KillCompletedAnnotation] = gs.Annotations[KillRequestedAnnotation]
	return r.Patch(ctx, gs, client.MergeFrom(base))
}
