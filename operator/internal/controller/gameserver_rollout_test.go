package controller

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

func TestRecoverStuckRollout(t *testing.T) {
	crashLooping := corev1.ContainerStatus{
		Name:         gameContainerName,
		RestartCount: crashLoopFailureThreshold,
		State:        corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
	}
	running := corev1.ContainerStatus{
		Name:  gameContainerName,
		State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
	}
	cases := []struct {
		name        string
		revision    string
		status      corev1.ContainerStatus
		wantDeleted bool
	}{
		{"crash-looping on old revision", "old", crashLooping, true},
		{"crash-looping on update revision", "new", crashLooping, false},
		{"healthy on old revision", "old", running, false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			scheme := wipeScheme(t)
			gs := &gameplanev1alpha1.GameServer{}
			gs.Name, gs.Namespace = "alpha", "ns"
			statefulSet := &appsv1.StatefulSet{}
			statefulSet.Name, statefulSet.Namespace = "alpha", "ns"
			statefulSet.Status.UpdateRevision = "new"
			pod := &corev1.Pod{}
			pod.Name, pod.Namespace = "alpha-0", "ns"
			pod.Labels = map[string]string{appsv1.ControllerRevisionHashLabelKey: testCase.revision}
			pod.Status.ContainerStatuses = []corev1.ContainerStatus{testCase.status}

			cl := fake.NewClientBuilder().WithScheme(scheme).WithObjects(gs, statefulSet, pod).Build()
			r := &GameServerReconciler{Client: cl, APIReader: cl, Scheme: scheme}
			if err := r.recoverStuckRollout(context.Background(), gs); err != nil {
				t.Fatalf("recoverStuckRollout: %v", err)
			}
			err := cl.Get(context.Background(), client.ObjectKeyFromObject(pod), &corev1.Pod{})
			if deleted := apierrors.IsNotFound(err); deleted != testCase.wantDeleted {
				t.Fatalf("pod deleted = %v, want %v (err %v)", deleted, testCase.wantDeleted, err)
			}
		})
	}
}
