//go:build envtest

package controller

import (
	"fmt"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/manager"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

func withGameServerSetReconciler() setupReconciler {
	return func(mgr manager.Manager) error {
		return (&GameServerSetReconciler{Client: mgr.GetClient(), Scheme: mgr.GetScheme()}).SetupWithManager(mgr)
	}
}

func buildGameServerSet(ns, name, tmplName string, replicas int32) *gameplanev1alpha1.GameServerSet {
	return &gameplanev1alpha1.GameServerSet{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec: gameplanev1alpha1.GameServerSetSpec{
			Replicas: replicas,
			Template: gameplanev1alpha1.GameServerSpec{
				TemplateRef: gameplanev1alpha1.GameTemplateRef{Name: tmplName},
			},
		},
	}
}

func updateGameServerSet(t *testing.T, ns, name string, mut func(*gameplanev1alpha1.GameServerSet)) {
	t.Helper()
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var set gameplanev1alpha1.GameServerSet
		if err := k8sClient.Get(t.Context(), types.NamespacedName{Namespace: ns, Name: name}, &set); err != nil {
			return err
		}
		mut(&set)
		return k8sClient.Update(t.Context(), &set)
	}); err != nil {
		t.Fatalf("update gameserverset %s: %v", name, err)
	}
}

func updateGameServer(t *testing.T, ns, name string, mut func(*gameplanev1alpha1.GameServer)) {
	t.Helper()
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var gs gameplanev1alpha1.GameServer
		if err := k8sClient.Get(t.Context(), types.NamespacedName{Namespace: ns, Name: name}, &gs); err != nil {
			return err
		}
		mut(&gs)
		return k8sClient.Update(t.Context(), &gs)
	}); err != nil {
		t.Fatalf("update gameserver %s: %v", name, err)
	}
}

func TestGameServerSet_ScalesChildren(t *testing.T) {
	ns := newNamespace(t)
	startMgr(t, ns, withGameServerSetReconciler())

	tmpl := buildGameTemplate(uniqueName("lobby-tmpl"))
	if err := k8sClient.Create(t.Context(), tmpl); err != nil {
		t.Fatal(err)
	}
	deleteCleanup(t, tmpl)

	set := buildGameServerSet(ns, "lobby", tmpl.Name, 3)
	set.Annotations = map[string]string{"gameplane.local/owner-id": "7"}
	if err := k8sClient.Create(t.Context(), set); err != nil {
		t.Fatal(err)
	}

	eventually(t, func() (bool, string) {
		var list gameplanev1alpha1.GameServerList
		if err := k8sClient.List(t.Context(), &list, client.InNamespace(ns), client.MatchingLabels{serverSetLabel: set.Name}); err != nil {
			return false, err.Error()
		}
		if len(list.Items) != 3 {
			return false, fmt.Sprintf("children = %d, want 3", len(list.Items))
		}
		for i := range 3 {
			var gs gameplanev1alpha1.GameServer
			if err := k8sClient.Get(t.Context(), types.NamespacedName{Namespace: ns, Name: fmt.Sprintf("%s-%d", set.Name, i)}, &gs); err != nil {
				return false, err.Error()
			}
			if ref := metav1.GetControllerOf(&gs); ref == nil || ref.UID != set.UID {
				return false, fmt.Sprintf("%s has no controller ownerReference to the set", gs.Name)
			}
			if gs.Annotations["gameplane.local/owner-id"] != "7" {
				return false, fmt.Sprintf("%s owner-id = %q, want 7", gs.Name, gs.Annotations["gameplane.local/owner-id"])
			}
		}
		return true, ""
	})

	eventually(t, func() (bool, string) {
		var got gameplanev1alpha1.GameServerSet
		if err := k8sClient.Get(t.Context(), types.NamespacedName{Namespace: ns, Name: set.Name}, &got); err != nil {
			return false, err.Error()
		}
		return got.Status.Replicas == 3, fmt.Sprintf("status.replicas = %d, want 3", got.Status.Replicas)
	})

	updateGameServerSet(t, ns, set.Name, func(set *gameplanev1alpha1.GameServerSet) { set.Spec.Replicas = 1 })

	eventually(t, func() (bool, string) {
		var list gameplanev1alpha1.GameServerList
		if err := k8sClient.List(t.Context(), &list, client.InNamespace(ns), client.MatchingLabels{serverSetLabel: set.Name}); err != nil {
			return false, err.Error()
		}
		if len(list.Items) != 1 || list.Items[0].Name != set.Name+"-0" {
			return false, fmt.Sprintf("children = %d, want only %s-0", len(list.Items), set.Name)
		}
		return true, ""
	})
}

func TestGameServerSet_TemplateChangeKeepsSuspend(t *testing.T) {
	ns := newNamespace(t)
	startMgr(t, ns, withGameServerSetReconciler())

	tmpl := buildGameTemplate(uniqueName("lobby-suspend"))
	if err := k8sClient.Create(t.Context(), tmpl); err != nil {
		t.Fatal(err)
	}
	deleteCleanup(t, tmpl)

	if err := k8sClient.Create(t.Context(), buildGameServerSet(ns, "lobby", tmpl.Name, 1)); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() (bool, string) {
		var gs gameplanev1alpha1.GameServer
		err := k8sClient.Get(t.Context(), types.NamespacedName{Namespace: ns, Name: "lobby-0"}, &gs)
		return err == nil, fmt.Sprint(err)
	})

	updateGameServer(t, ns, "lobby-0", func(gs *gameplanev1alpha1.GameServer) { gs.Spec.Suspend = true })
	updateGameServerSet(t, ns, "lobby", func(set *gameplanev1alpha1.GameServerSet) { set.Spec.Template.Image = "example.com/lobby:2" })

	eventually(t, func() (bool, string) {
		var gs gameplanev1alpha1.GameServer
		if err := k8sClient.Get(t.Context(), types.NamespacedName{Namespace: ns, Name: "lobby-0"}, &gs); err != nil {
			return false, err.Error()
		}
		if gs.Spec.Image != "example.com/lobby:2" {
			return false, "child image = " + gs.Spec.Image + ", want example.com/lobby:2"
		}
		return gs.Spec.Suspend, "child suspend cleared by template change"
	})
}

func TestGameServerSet_IgnoresUnownedServer(t *testing.T) {
	ns := newNamespace(t)
	startMgr(t, ns, withGameServerSetReconciler())

	stray := buildGameServer(ns, "lobby-9", "lobby-tmpl")
	stray.Labels = map[string]string{serverSetLabel: "lobby"}
	if err := k8sClient.Create(t.Context(), stray); err != nil {
		t.Fatal(err)
	}
	if err := k8sClient.Create(t.Context(), buildGameServerSet(ns, "lobby", "lobby-tmpl", 1)); err != nil {
		t.Fatal(err)
	}

	eventually(t, func() (bool, string) {
		var gs gameplanev1alpha1.GameServer
		err := k8sClient.Get(t.Context(), types.NamespacedName{Namespace: ns, Name: "lobby-0"}, &gs)
		return err == nil, fmt.Sprint(err)
	})
	consistently(t, time.Second, func() (bool, string) {
		var gs gameplanev1alpha1.GameServer
		err := k8sClient.Get(t.Context(), types.NamespacedName{Namespace: ns, Name: "lobby-9"}, &gs)
		return err == nil, "unowned server removed: " + fmt.Sprint(err)
	})
}

func TestGameServer_EphemeralUsesEmptyDir(t *testing.T) {
	ns := newNamespace(t)
	startMgr(t, ns, withGameServerReconciler(t, ns))

	tmpl := buildGameTemplate(uniqueName("ephemeral"))
	if err := k8sClient.Create(t.Context(), tmpl); err != nil {
		t.Fatal(err)
	}
	deleteCleanup(t, tmpl)

	gs := buildGameServer(ns, "scratch", tmpl.Name)
	gs.Spec.Storage = &gameplanev1alpha1.GameStorageSpec{Ephemeral: true}
	if err := k8sClient.Create(t.Context(), gs); err != nil {
		t.Fatal(err)
	}

	eventually(t, func() (bool, string) {
		var ss appsv1.StatefulSet
		if err := k8sClient.Get(t.Context(), types.NamespacedName{Namespace: ns, Name: "scratch"}, &ss); err != nil {
			return false, err.Error()
		}
		for _, volume := range ss.Spec.Template.Spec.Volumes {
			if volume.Name == "data" {
				return volume.EmptyDir != nil && volume.PersistentVolumeClaim == nil, "data volume is not an EmptyDir"
			}
		}
		return false, "no data volume on statefulset"
	})

	var pvc corev1.PersistentVolumeClaim
	err := k8sClient.Get(t.Context(), types.NamespacedName{Namespace: ns, Name: "scratch-data"}, &pvc)
	if !apierrors.IsNotFound(err) {
		t.Fatalf("pvc scratch-data: want NotFound, got %v", err)
	}
}

func TestGameServer_SetLabelOnPodTemplate(t *testing.T) {
	ns := newNamespace(t)
	startMgr(t, ns, withGameServerReconciler(t, ns))

	tmpl := buildGameTemplate(uniqueName("lobby-pod"))
	if err := k8sClient.Create(t.Context(), tmpl); err != nil {
		t.Fatal(err)
	}
	deleteCleanup(t, tmpl)

	isController := true
	gs := buildGameServer(ns, "member", tmpl.Name)
	gs.Labels = map[string]string{serverSetLabel: "lobby"}
	gs.OwnerReferences = []metav1.OwnerReference{{
		APIVersion: "gameplane.local/v1alpha1",
		Kind:       "GameServerSet",
		Name:       "lobby",
		UID:        "lobby-uid",
		Controller: &isController,
	}}
	if err := k8sClient.Create(t.Context(), gs); err != nil {
		t.Fatal(err)
	}

	unowned := buildGameServer(ns, "unowned", tmpl.Name)
	unowned.Labels = map[string]string{serverSetLabel: "lobby"}
	if err := k8sClient.Create(t.Context(), unowned); err != nil {
		t.Fatal(err)
	}

	eventually(t, func() (bool, string) {
		var ss appsv1.StatefulSet
		if err := k8sClient.Get(t.Context(), types.NamespacedName{Namespace: ns, Name: "member"}, &ss); err != nil {
			return false, err.Error()
		}
		if ss.Spec.Template.Labels[serverSetLabel] != "lobby" {
			return false, fmt.Sprintf("pod template labels = %v", ss.Spec.Template.Labels)
		}
		_, inSelector := ss.Spec.Selector.MatchLabels[serverSetLabel]
		return !inSelector, "set label leaked into statefulset selector"
	})

	eventually(t, func() (bool, string) {
		var ss appsv1.StatefulSet
		if err := k8sClient.Get(t.Context(), types.NamespacedName{Namespace: ns, Name: "unowned"}, &ss); err != nil {
			return false, err.Error()
		}
		_, labelled := ss.Spec.Template.Labels[serverSetLabel]
		return !labelled, fmt.Sprintf("unowned server pod template labels = %v", ss.Spec.Template.Labels)
	})
}

func TestGameServer_EphemeralAdmission(t *testing.T) {
	ns := newNamespace(t)

	withBackup := buildGameServer(ns, "ephemeral-backup", "some-template")
	withBackup.Spec.Storage = &gameplanev1alpha1.GameStorageSpec{Ephemeral: true}
	withBackup.Spec.BackupPolicy = &gameplanev1alpha1.InlineBackupPolicy{
		Schedule: "0 4 * * *",
		RepoRef:  gameplanev1alpha1.SecretKeySelector{Name: "creds", Key: "repo"},
	}
	if err := k8sClient.Create(t.Context(), withBackup); err == nil || !strings.Contains(err.Error(), "ephemeral") {
		t.Fatalf("ephemeral with backupPolicy: want rejection mentioning ephemeral, got %v", err)
	}

	gs := buildGameServer(ns, "ephemeral", "some-template")
	gs.Spec.Storage = &gameplanev1alpha1.GameStorageSpec{Ephemeral: true}
	if err := k8sClient.Create(t.Context(), gs); err != nil {
		t.Fatalf("create ephemeral gameserver: %v", err)
	}

	gs.Spec.Storage.Ephemeral = false
	if err := k8sClient.Update(t.Context(), gs); err == nil || !strings.Contains(err.Error(), "immutable") {
		t.Fatalf("flip ephemeral: want rejection mentioning immutable, got %v", err)
	}
}

func TestGameServerSet_NameLength(t *testing.T) {
	ns := newNamespace(t)

	long := buildGameServerSet(ns, strings.Repeat("a", 41), "some-template", 1)
	if err := k8sClient.Create(t.Context(), long); !apierrors.IsInvalid(err) {
		t.Fatalf("41-char name: want Invalid, got %v", err)
	}

	exact := buildGameServerSet(ns, strings.Repeat("a", 40), "some-template", 1)
	if err := k8sClient.Create(t.Context(), exact); err != nil {
		t.Fatalf("40-char name rejected: %v", err)
	}
}
