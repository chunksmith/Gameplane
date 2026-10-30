package controller

import (
	"context"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

func (r *GameServerReconciler) recoverStuckRollout(ctx context.Context, gs *gameplanev1alpha1.GameServer) error {
	var statefulSet appsv1.StatefulSet
	if err := r.Get(ctx, client.ObjectKeyFromObject(gs), &statefulSet); err != nil {
		return client.IgnoreNotFound(err)
	}
	updateRevision := statefulSet.Status.UpdateRevision
	if updateRevision == "" || statefulSet.Status.ObservedGeneration != statefulSet.Generation {
		return nil
	}
	var pod corev1.Pod
	if err := r.Get(ctx, types.NamespacedName{Namespace: gs.Namespace, Name: gs.Name + "-0"}, &pod); err != nil {
		return client.IgnoreNotFound(err)
	}
	if pod.DeletionTimestamp != nil || pod.Labels[appsv1.ControllerRevisionHashLabelKey] == updateRevision {
		return nil
	}
	if _, _, failed := startupFailure(&pod); !failed {
		return nil
	}
	if err := r.Delete(ctx, &pod); client.IgnoreNotFound(err) != nil {
		return fmt.Errorf("delete stale pod: %w", err)
	}
	return nil
}
