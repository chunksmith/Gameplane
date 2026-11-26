package controller

import (
	"slices"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

func TestResticJobsCarryOptionalS3Credentials(t *testing.T) {
	backup := &gameplanev1alpha1.Backup{}
	backup.Namespace = "ns"
	backup.Spec.ServerRef = gameplanev1alpha1.LocalObjectRef{Name: "smp"}
	backup.Spec.RepoRef = &gameplanev1alpha1.SecretKeySelector{Name: "repo"}
	restore := &gameplanev1alpha1.Restore{}
	restore.Status.SnapshotID = "snap-1"
	tmpl := &gameplanev1alpha1.GameTemplate{}

	backupSpec := (&BackupReconciler{}).buildBackupPodSpec(backup, tmpl, "smp-data")
	restoreSpec := (&RestoreReconciler{}).buildRestorePodSpec(restore, backup, tmpl, "smp-data")
	forgetSpec := (&BackupReconciler{}).buildForgetPodSpec(backup)

	var containers []corev1.Container
	for _, spec := range []corev1.PodSpec{backupSpec, restoreSpec, forgetSpec} {
		containers = append(containers, spec.InitContainers...)
		containers = append(containers, spec.Containers...)
	}
	for _, container := range containers {
		for _, key := range []string{"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"} {
			index := slices.IndexFunc(container.Env, func(env corev1.EnvVar) bool { return env.Name == key })
			if index < 0 {
				t.Errorf("%s: missing %s", container.Name, key)
				continue
			}
			ref := container.Env[index].ValueFrom.SecretKeyRef
			if ref.Name != "repo" || ref.Key != key || ref.Optional == nil || !*ref.Optional {
				t.Errorf("%s: %s = %+v, want optional key %s of Secret repo", container.Name, key, ref, key)
			}
		}
	}
}

func TestBackupArgsExcludeLostFoundAndLimitUpload(t *testing.T) {
	backup := &gameplanev1alpha1.Backup{}
	backup.Spec.ServerRef = gameplanev1alpha1.LocalObjectRef{Name: "smp"}
	backup.Spec.RepoRef = &gameplanev1alpha1.SecretKeySelector{Name: "repo"}
	tmpl := &gameplanev1alpha1.GameTemplate{}

	unlimited := (&BackupReconciler{}).buildBackupPodSpec(backup, tmpl, "smp-data").Containers[0].Args
	if !slices.Contains(unlimited, "--exclude=/data/lost+found") {
		t.Errorf("args = %v, want --exclude=/data/lost+found", unlimited)
	}
	if slices.ContainsFunc(unlimited, func(arg string) bool { return strings.HasPrefix(arg, "--limit-upload") }) {
		t.Errorf("args = %v, want no --limit-upload when unset", unlimited)
	}

	limited := (&BackupReconciler{ResticLimitUpload: 40960}).buildBackupPodSpec(backup, tmpl, "smp-data").Containers[0].Args
	if !slices.Contains(limited, "--limit-upload=40960") {
		t.Errorf("args = %v, want --limit-upload=40960", limited)
	}
}
