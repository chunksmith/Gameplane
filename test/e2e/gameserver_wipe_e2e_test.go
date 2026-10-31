//go:build e2e

package e2e

import (
	"context"
	"fmt"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
)

func TestGameServer_WipeClearsForeignOwnedFiles(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	ns := "gameplane-games"
	tmpl := "e2e-wipe-busybox"
	gs := "e2e-wipe-unwritable"

	applyBusyboxTemplate(t, tmpl)
	applyBusyboxGameServer(t, ns, gs, tmpl)

	envInstance.Eventually(t, 60*time.Second, func() (bool, string) {
		_, err := envInstance.K8s.AppsV1().StatefulSets(ns).Get(ctx, gs, metav1.GetOptions{})
		if err != nil {
			return false, "ss not yet: " + err.Error()
		}
		return true, ""
	})
	waitPVCBound(t, ns, gs+"-data", 90*time.Second)

	suspendPatch := []byte(`{"spec":{"suspend":true}}`)
	if _, err := envInstance.Dyn.Resource(gameServerGVR).Namespace(ns).
		Patch(ctx, gs, types.MergePatchType, suspendPatch, metav1.PatchOptions{}); err != nil {
		t.Fatalf("patch suspend=true: %v", err)
	}
	envInstance.Eventually(t, 60*time.Second, func() (bool, string) {
		ss, err := envInstance.K8s.AppsV1().StatefulSets(ns).Get(ctx, gs, metav1.GetOptions{})
		if err != nil {
			return false, "get ss: " + err.Error()
		}
		if ss.Spec.Replicas != nil && *ss.Spec.Replicas == 0 {
			return true, ""
		}
		return false, fmt.Sprintf("expected replicas=0, got %v", ss.Spec.Replicas)
	})

	runDataJob(t, ns, gs+"-wipe-prep", gs+"-data",
		"touch /data/level.dat && chmod 0600 /data/level.dat && "+
			"mkdir -p /data/locked && touch /data/locked/keep.txt && chmod 0600 /data/locked/keep.txt && "+
			"chown 1000:1000 /data/locked && chmod 0755 /data/locked")

	token := "e2e-wipe-token-1"
	wipePatch := []byte(fmt.Sprintf(`{"metadata":{"annotations":{"gameplane.local/wipe-data-requested":%q}}}`, token))
	if _, err := envInstance.Dyn.Resource(gameServerGVR).Namespace(ns).
		Patch(ctx, gs, types.MergePatchType, wipePatch, metav1.PatchOptions{}); err != nil {
		t.Fatalf("patch wipe request: %v", err)
	}

	envInstance.Eventually(t, 120*time.Second, func() (bool, string) {
		got, err := envInstance.Dyn.Resource(gameServerGVR).Namespace(ns).Get(ctx, gs, metav1.GetOptions{})
		if err != nil {
			return false, "get gameserver: " + err.Error()
		}
		if cond := findCondition(got.Object, "DataWipe"); cond != nil {
			return false, fmt.Sprintf("DataWipe condition set: status=%v reason=%v", cond["status"], cond["reason"])
		}
		done, _, _ := unstructured.NestedString(got.Object, "metadata", "annotations", "gameplane.local/wipe-data-completed")
		if done != token {
			return false, fmt.Sprintf("wipe-data-completed=%q, want %q", done, token)
		}
		return true, ""
	})

	runDataJob(t, ns, gs+"-wipe-check", gs+"-data", `test -z "$(ls -A /data)"`)
}

func runDataJob(t *testing.T, ns, name, claim, script string) {
	t.Helper()
	ctx := context.Background()
	var (
		root      = int64(0)
		nonRoot   = false
		noPrivEsc = false
		backoff0  = int32(0)
	)
	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec: batchv1.JobSpec{
			BackoffLimit: &backoff0,
			Template: corev1.PodTemplateSpec{
				Spec: corev1.PodSpec{
					RestartPolicy: corev1.RestartPolicyNever,
					SecurityContext: &corev1.PodSecurityContext{
						SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
					},
					Containers: []corev1.Container{{
						Name:         "run",
						Image:        "busybox:1.36",
						Command:      []string{"/bin/sh", "-c"},
						Args:         []string{script},
						VolumeMounts: []corev1.VolumeMount{{Name: "data", MountPath: "/data"}},
						SecurityContext: &corev1.SecurityContext{
							RunAsNonRoot:             &nonRoot,
							RunAsUser:                &root,
							RunAsGroup:               &root,
							AllowPrivilegeEscalation: &noPrivEsc,
							Capabilities: &corev1.Capabilities{
								Drop: []corev1.Capability{"ALL"},
								Add:  []corev1.Capability{"CHOWN"},
							},
						},
					}},
					Volumes: []corev1.Volume{{
						Name: "data",
						VolumeSource: corev1.VolumeSource{
							PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: claim},
						},
					}},
				},
			},
		},
	}
	bg := metav1.DeletePropagationBackground
	t.Cleanup(func() {
		_ = envInstance.K8s.BatchV1().Jobs(ns).Delete(context.Background(), name, metav1.DeleteOptions{PropagationPolicy: &bg})
	})
	if _, err := envInstance.K8s.BatchV1().Jobs(ns).Create(ctx, job, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create job %s: %v", name, err)
	}
	envInstance.Eventually(t, 90*time.Second, func() (bool, string) {
		j, err := envInstance.K8s.BatchV1().Jobs(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return false, "get job: " + err.Error()
		}
		if j.Status.Succeeded > 0 {
			return true, ""
		}
		if j.Status.Failed > 0 {
			t.Fatalf("job %s failed", name)
		}
		return false, fmt.Sprintf("job %s not done", name)
	})
}
