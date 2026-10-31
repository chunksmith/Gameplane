package controller

import (
	"context"
	"fmt"
	"time"

	batchv1 "k8s.io/api/batch/v1"
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
	if gs.Annotations[wipeGuardAnnotation] != "" || pendingWipe(gs) {
		if err := r.reconcileWipe(ctx, gs, &tmpl); err != nil {
			if apierrors.IsConflict(err) {
				return ctrl.Result{Requeue: true}, nil
			}
			return ctrl.Result{}, fmt.Errorf("reconcile data wipe: %w", err)
		}
	}
	if err := r.releaseReplicaFence(ctx, gs); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.stopSuspendedReplica(ctx, gs); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileNodePlacement(ctx, gs); err != nil {
		log.FromContext(ctx).Error(err, "reconcile node placement")
	}
	if err := r.reconcileBackupSchedule(ctx, gs); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile BackupSchedule: %w", err)
	}
	gs.Spec.Suspend = gs.Spec.Suspend || set.Spec.Template.Suspend
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

func (r *GameServerReconciler) stopSuspendedReplica(ctx context.Context, gs *gameplanev1alpha1.GameServer) error {
	if !gs.Spec.Suspend {
		return nil
	}
	var pod corev1.Pod
	if err := r.Get(ctx, types.NamespacedName{Namespace: gs.Namespace, Name: gamePodName(gs)}, &pod); err != nil {
		return client.IgnoreNotFound(err)
	}
	if pod.DeletionTimestamp != nil || !replicaReleased(&pod) {
		return nil
	}
	uid := pod.UID
	if err := r.Delete(ctx, &pod, client.Preconditions{UID: &uid}); client.IgnoreNotFound(err) != nil {
		return fmt.Errorf("stop replica pod: %w", err)
	}
	return nil
}

func (r *GameServerReconciler) releaseReplicaFence(ctx context.Context, gs *gameplanev1alpha1.GameServer) error {
	if gs.Annotations[replicaFenceAnnotation] == "" || gs.Annotations[wipeGuardAnnotation] != "" || gs.Annotations[restoreGuardAnnotation] != "" {
		return nil
	}
	delete(gs.Annotations, replicaFenceAnnotation)
	return r.Update(ctx, gs)
}

func replicaTargetStopped(
	ctx context.Context, writer client.Client, reader client.Reader, gs *gameplanev1alpha1.GameServer,
) (stopped, progressed bool, err error) {
	var pod corev1.Pod
	err = reader.Get(ctx, types.NamespacedName{Namespace: gs.Namespace, Name: gamePodName(gs)}, &pod)
	if err != nil && !apierrors.IsNotFound(err) {
		return false, false, err
	}
	if err == nil {
		fence := gs.Annotations[replicaFenceAnnotation]
		if !pod.DeletionTimestamp.IsZero() {
			return false, false, nil
		}
		if fence == "" || fence == string(pod.UID) || replicaReleased(&pod) {
			if fence != string(pod.UID) {
				if gs.Annotations == nil {
					gs.Annotations = map[string]string{}
				}
				gs.Annotations[replicaFenceAnnotation] = string(pod.UID)
				if err := writer.Update(ctx, gs); err != nil {
					return false, false, err
				}
			}
			uid := pod.UID
			if err := writer.Delete(ctx, &pod, client.Preconditions{UID: &uid}); client.IgnoreNotFound(err) != nil {
				return false, false, fmt.Errorf("fence replica pod: %w", err)
			}
			return false, true, nil
		}
	}
	busy, err := claimInUse(ctx, reader, gs.Namespace, dataClaimName(gs), gamePodName(gs))
	return err == nil && !busy, false, err
}

func claimInUse(ctx context.Context, reader client.Reader, namespace, claim, replicaPod string) (bool, error) {
	var pods corev1.PodList
	if err := reader.List(ctx, &pods, client.InNamespace(namespace)); err != nil {
		return false, err
	}
	for i := range pods.Items {
		pod := &pods.Items[i]
		if pod.Name != replicaPod && liveRestorePod(pod) && podMountsRestoreTarget(pod, claim) {
			return true, nil
		}
	}
	var jobs batchv1.JobList
	if err := reader.List(ctx, &jobs, client.InNamespace(namespace)); err != nil {
		return false, err
	}
	for i := range jobs.Items {
		job := &jobs.Items[i]
		active := !job.DeletionTimestamp.IsZero() || job.Status.Active > 0 || (job.Status.Succeeded == 0 && !jobPermanentlyFailed(job))
		if active && podMountsRestoreTarget(&corev1.Pod{Spec: job.Spec.Template.Spec}, claim) {
			return true, nil
		}
	}
	return false, nil
}
