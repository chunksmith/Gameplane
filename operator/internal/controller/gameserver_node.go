package controller

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

// nodeAnnotation records which node the game pod is currently scheduled on.
// The dashboard's Servers table reads it directly. It carries observed runtime
// state as an annotation rather than a CRD status field so surfacing node
// placement needs no schema change; the operator refreshes it each reconcile.
const nodeAnnotation = "gameplane.local/node"

// reconcileNodePlacement keeps the gameplane.local/node annotation in sync with
// the node the game pod (<name>-0) is scheduled on. When no pod is running
// (stopped / suspended) the last known node is kept so the dashboard still
// shows where the server's data lives. It patches metadata only and only when
// the value actually changes, so it never loops on its own update event.
func (r *GameServerReconciler) reconcileNodePlacement(ctx context.Context, gs *gameplanev1alpha1.GameServer) error {
	var pod corev1.Pod
	err := r.Get(ctx, types.NamespacedName{Name: gamePodName(gs), Namespace: gs.Namespace}, &pod)
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("get pod %s: %w", gamePodName(gs), err)
	}
	node := pod.Spec.NodeName
	if node == "" || gs.Annotations[nodeAnnotation] == node {
		return nil
	}

	base := gs.DeepCopy()
	if gs.Annotations == nil {
		gs.Annotations = map[string]string{}
	}
	gs.Annotations[nodeAnnotation] = node
	return r.Patch(ctx, gs, client.MergeFrom(base))
}
