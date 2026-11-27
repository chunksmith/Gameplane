package controller

import (
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

func TestBackupSetReplicaCopiesWithoutTouchingSharedStatefulSet(t *testing.T) {
	b := guardBackup("copy")
	b.Spec.Quiesce = false
	b.Spec.ServerRef.Name = "set-0"
	r, q := guardFixture(t, b)
	replicas := int32(16)
	set := &appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: "set", Namespace: "ns", UID: "set-sts-uid"}, Spec: appsv1.StatefulSetSpec{Replicas: &replicas}}
	replica := &gameplanev1alpha1.GameServer{ObjectMeta: metav1.ObjectMeta{Name: "set-0", Namespace: "ns", UID: "set-0-uid", Labels: map[string]string{serverSetStatefulSetLabel: "set"}}, Spec: gameplanev1alpha1.GameServerSpec{TemplateRef: gameplanev1alpha1.GameTemplateRef{Name: "template"}}}
	for _, object := range []client.Object{set, replica} {
		if err := r.Create(t.Context(), object); err != nil {
			t.Fatal(err)
		}
	}
	guardPass(t, r, "copy")

	var job batchv1.Job
	if err := r.Get(t.Context(), client.ObjectKey{Namespace: "ns", Name: "copy"}, &job); err != nil {
		t.Fatalf("replica backup created no Job: %v", err)
	}
	if claim := job.Spec.Template.Spec.Volumes[0].PersistentVolumeClaim.ClaimName; claim != "data-set-0" {
		t.Fatalf("replica backup mounted %q, want data-set-0", claim)
	}
	var live appsv1.StatefulSet
	if err := r.Get(t.Context(), client.ObjectKeyFromObject(set), &live); err != nil {
		t.Fatal(err)
	}
	if live.Annotations[lifecycleOperationAnnotation] != "" || *live.Spec.Replicas != 16 {
		t.Fatalf("replica backup mutated the shared StatefulSet: %+v", live.Annotations)
	}
	if q.quiesced != 0 {
		t.Fatalf("quiesce=false backup quiesced the replica: %+v", q)
	}

	job.Status.Succeeded = 1
	if err := r.Status().Update(t.Context(), &job); err != nil {
		t.Fatal(err)
	}
	guardPass(t, r, "copy")
	if phase := guardGetBackup(t, r, "copy").Status.Phase; phase != gameplanev1alpha1.BackupPhaseSucceeded {
		t.Fatalf("replica backup phase %q, want Succeeded", phase)
	}
	assertBackupLockReleased(t, r, "set-0")
}

func TestBackupMissingWorkloadFailsAndReleasesLock(t *testing.T) {
	for _, tc := range []struct {
		name   string
		age    time.Duration
		failed bool
	}{
		{name: "within grace", age: 0, failed: false},
		{name: "past grace", age: 2 * backupWorkloadGrace, failed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := guardBackup("copy")
			b.Spec.Quiesce = false
			b.CreationTimestamp = metav1.NewTime(time.Now().Add(-tc.age))
			r, _ := guardFixture(t, b)
			if err := r.Delete(t.Context(), &appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: "server", Namespace: "ns"}}); err != nil {
				t.Fatal(err)
			}
			guardPass(t, r, "copy")
			failed := guardGetBackup(t, r, "copy").Status.Phase == gameplanev1alpha1.BackupPhaseFailed
			if failed != tc.failed {
				t.Fatalf("failed=%t, want %t", failed, tc.failed)
			}
			if tc.failed {
				assertBackupLockReleased(t, r, "server")
			}
		})
	}
}

func assertBackupLockReleased(t *testing.T, r *BackupReconciler, server string) {
	t.Helper()
	var gs gameplanev1alpha1.GameServer
	if err := r.Get(t.Context(), client.ObjectKey{Namespace: "ns", Name: server}, &gs); err != nil {
		t.Fatal(err)
	}
	if gs.Annotations[lifecycleOperationAnnotation] != "" || gs.Annotations[backupGuardAnnotation] != "" {
		t.Fatalf("backup left %s locked: %v", server, gs.Annotations)
	}
}
