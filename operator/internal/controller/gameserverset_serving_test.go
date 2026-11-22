package controller

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

func readyPod(name, revision string, since time.Duration) *corev1.Pod {
	at := metav1.NewTime(time.Now().Add(-since))
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Labels: map[string]string{"rev": revision}},
		Status: corev1.PodStatus{Conditions: []corev1.PodCondition{
			{Type: corev1.PodReady, Status: corev1.ConditionTrue, LastTransitionTime: at},
			{Type: corev1.ContainersReady, Status: corev1.ConditionTrue, LastTransitionTime: at},
		}},
	}
}

func currentIs(revision string) func(*corev1.Pod) bool {
	return func(pod *corev1.Pod) bool { return pod.Labels["rev"] == revision }
}

func TestRolloutPlanDeletesHighestOldPod(t *testing.T) {
	pods := map[string]*corev1.Pod{
		"set-0": readyPod("set-0", "old", time.Hour),
		"set-1": readyPod("set-1", "old", time.Hour),
		"set-2": readyPod("set-2", "new", time.Hour),
	}
	doomed, requeue := rolloutPlan("set", 3, pods, currentIs("new"), nil, 20*time.Second)
	if len(doomed) != 1 || doomed[0].Name != "set-1" || requeue != rolloutRequeue {
		t.Fatalf("doomed=%v requeue=%v", doomed, requeue)
	}
	pods["set-2"] = readyPod("set-2", "new", 5*time.Second)
	doomed, requeue = rolloutPlan("set", 3, pods, currentIs("new"), nil, 20*time.Second)
	if len(doomed) != 0 || requeue <= 0 {
		t.Fatalf("waits for minReady: doomed=%v requeue=%v", doomed, requeue)
	}
}

func TestServingDuringRollout(t *testing.T) {
	oldPod := readyPod("set-0", "old", time.Hour)
	doomedPod := readyPod("set-1", "old", time.Hour)
	newPod := readyPod("set-2", "new", time.Minute)
	inputs := servingInputs{current: currentIs("new"), doomed: []*corev1.Pod{doomedPod}}

	if !inputs.serving(oldPod) || inputs.serving(doomedPod) || !inputs.serving(newPod) {
		t.Fatal("before an updated replica is available only the doomed pod stops serving")
	}
	inputs.updatedAvailable = true
	if inputs.serving(oldPod) || !inputs.serving(newPod) {
		t.Fatal("once an updated replica is available every old pod stops serving")
	}
	if enabled, decided := inputs.edgeEnabled(oldPod, gameplanev1alpha1.EdgeDisableOnUnserve); !decided || enabled {
		t.Fatal("unserve edge follows serving")
	}
	if enabled, decided := inputs.edgeEnabled(oldPod, gameplanev1alpha1.EdgeDisableOnStop); !decided || !enabled {
		t.Fatal("stop edge stays enabled while the pod runs")
	}
	terminating := oldPod.DeepCopy()
	terminating.DeletionTimestamp = &metav1.Time{Time: time.Now()}
	if _, decided := inputs.edgeEnabled(terminating, gameplanev1alpha1.EdgeDisableOnStop); decided {
		t.Fatal("stop edge is left alone while the pod drains")
	}
	if enabled, decided := inputs.edgeEnabled(nil, gameplanev1alpha1.EdgeDisableOnStop); !decided || enabled {
		t.Fatal("stop edge is disabled once the pod is gone")
	}
}
