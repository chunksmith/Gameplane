package controller

import (
	"context"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

func (r *GameServerReconciler) reconcileStatefulSetReplica(ctx context.Context, gs *gameplanev1alpha1.GameServer) (ctrl.Result, error) {
	set, err := r.replicaOwner(ctx, gs)
	if err != nil {
		return ctrl.Result{}, err
	}
	if set == nil {
		return ctrl.Result{}, r.setPhase(ctx, gs, "not a replica of a StatefulSet server group")
	}
	var tmpl gameplanev1alpha1.GameTemplate
	if err := r.Get(ctx, types.NamespacedName{Name: gs.Spec.TemplateRef.Name}, &tmpl); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{RequeueAfter: 15 * time.Second}, r.setPhase(ctx, gs,
				fmt.Sprintf("GameTemplate %q not found", gs.Spec.TemplateRef.Name))
		}
		return ctrl.Result{}, err
	}
	if err := r.reconcileAgentService(ctx, gs); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile agent Service: %w", err)
	}
	if err := r.reconcileNetworkPolicy(ctx, gs, &tmpl); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile ingress NetworkPolicy: %w", err)
	}
	if err := r.reconcileService(ctx, gs, &tmpl, false); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile Service: %w", err)
	}
	if err := r.forceKill(ctx, gs); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.restartReplica(ctx, gs); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileNodePlacement(ctx, gs); err != nil {
		log.FromContext(ctx).Error(err, "reconcile node placement")
	}
	if err := r.reconcileBackupSchedule(ctx, gs); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile BackupSchedule: %w", err)
	}
	requeue, err := r.reconcileStatus(ctx, gs, idleAwake, nil, nil, tunnelPlan{}, &tmpl, nil, "")
	return ctrl.Result{RequeueAfter: requeue}, err
}

func (r *GameServerReconciler) replicaOwner(ctx context.Context, gs *gameplanev1alpha1.GameServer) (*gameplanev1alpha1.GameServerSet, error) {
	name := gs.Labels[serverSetStatefulSetLabel]
	owner := metav1.GetControllerOf(gs)
	if owner == nil || owner.Kind != "GameServerSet" || owner.Name != name {
		return nil, nil
	}
	var set gameplanev1alpha1.GameServerSet
	if err := r.Get(ctx, types.NamespacedName{Namespace: gs.Namespace, Name: name}, &set); err != nil {
		return nil, client.IgnoreNotFound(err)
	}
	if set.UID != owner.UID || set.Spec.Mode != gameplanev1alpha1.GameServerSetModeStatefulSet {
		return nil, nil
	}
	return &set, nil
}

func (r *GameServerReconciler) restartReplica(ctx context.Context, gs *gameplanev1alpha1.GameServer) error {
	if !tokenPending(gs, RestartRequestedAnnotation, RestartCompletedAnnotation) {
		return nil
	}
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: gs.Namespace, Name: gamePodName(gs)}}
	if err := r.Delete(ctx, pod); client.IgnoreNotFound(err) != nil {
		return fmt.Errorf("restart replica pod: %w", err)
	}
	return r.ackRestart(ctx, gs)
}
