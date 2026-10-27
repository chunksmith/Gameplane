//go:build envtest

package controller

import (
	"context"
	"fmt"
	"slices"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/manager"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

func withRepositoryReconciler(t *testing.T, ns string) setupReconciler {
	t.Helper()
	seedAgentCA(t, ns, "agent-ca")
	return func(mgr manager.Manager) error {
		return (&RepositoryReconciler{
			Client:                 mgr.GetClient(),
			Scheme:                 mgr.GetScheme(),
			AgentImage:             "ghcr.io/gameplanepanel/gameplane/repo-agent:test",
			AgentImagePullPolicy:   "Always",
			AgentCASecretName:      "agent-ca",
			AgentCASecretNamespace: ns,
		}).SetupWithManager(mgr)
	}
}

func createRepository(t *testing.T, ns, name string, mutate func(*gameplanev1alpha1.Repository)) *gameplanev1alpha1.Repository {
	t.Helper()
	repo := &gameplanev1alpha1.Repository{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec: gameplanev1alpha1.RepositorySpec{
			URL:    "https://github.com/chunksmith/lfln-bettermodel",
			Branch: "main",
		},
	}
	if mutate != nil {
		mutate(repo)
	}
	if err := k8sClient.Create(context.Background(), repo); err != nil {
		t.Fatalf("create Repository: %v", err)
	}
	return repo
}

func isControlledBy(object metav1.Object, repo *gameplanev1alpha1.Repository) bool {
	owner := metav1.GetControllerOf(object)
	return owner != nil && owner.Kind == "Repository" && owner.Name == repo.Name
}

func TestRepository_CreatesChildren(t *testing.T) {
	ns := newNamespace(t)
	startMgr(t, ns, withRepositoryReconciler(t, ns))
	storageClass := "fast"
	repo := createRepository(t, ns, "lfln", func(repo *gameplanev1alpha1.Repository) {
		repo.Spec.Storage = gameplanev1alpha1.RepositoryStorage{
			Size:             resource.MustParse("5Gi"),
			StorageClassName: &storageClass,
		}
	})
	ctx := context.Background()

	eventually(t, func() (bool, string) {
		var pvc corev1.PersistentVolumeClaim
		if err := k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "lfln-data"}, &pvc); err != nil {
			return false, err.Error()
		}
		size := pvc.Spec.Resources.Requests[corev1.ResourceStorage]
		if size.String() != "5Gi" || pvc.Spec.StorageClassName == nil || *pvc.Spec.StorageClassName != "fast" {
			return false, fmt.Sprintf("pvc size=%s class=%v", size.String(), pvc.Spec.StorageClassName)
		}
		return isControlledBy(&pvc, repo), "pvc not owned by repository"
	})

	eventually(t, func() (bool, string) {
		var svc corev1.Service
		if err := k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "lfln-agent"}, &svc); err != nil {
			return false, err.Error()
		}
		if svc.Spec.Type != corev1.ServiceTypeClusterIP || len(svc.Spec.Ports) != 1 || svc.Spec.Ports[0].Port != 8090 {
			return false, fmt.Sprintf("service spec %+v", svc.Spec)
		}
		if svc.Spec.Selector["app.kubernetes.io/name"] != "gameplane-repo" || svc.Spec.Selector["app.kubernetes.io/instance"] != "lfln" {
			return false, fmt.Sprintf("selector %v", svc.Spec.Selector)
		}
		return isControlledBy(&svc, repo), "service not owned by repository"
	})

	eventually(t, func() (bool, string) {
		var secret corev1.Secret
		if err := k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "lfln-agent-tls"}, &secret); err != nil {
			return false, err.Error()
		}
		if len(secret.Data[corev1.TLSCertKey]) == 0 || len(secret.Data["ca.crt"]) == 0 {
			return false, "tls secret missing keys"
		}
		if !certValidFor(secret.Data[corev1.TLSCertKey], agentCertRenewalThreshold, []string{"lfln-agent." + ns + ".svc"}) {
			return false, "cert lacks agent service SAN"
		}
		return isControlledBy(&secret, repo), "tls secret not owned by repository"
	})

	eventually(t, func() (bool, string) {
		var sts appsv1.StatefulSet
		if err := k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "lfln"}, &sts); err != nil {
			return false, err.Error()
		}
		if sts.Spec.Replicas == nil || *sts.Spec.Replicas != 1 || sts.Spec.ServiceName != "lfln-agent" {
			return false, fmt.Sprintf("replicas=%v service=%s", sts.Spec.Replicas, sts.Spec.ServiceName)
		}
		pod := sts.Spec.Template.Spec
		if len(pod.Containers) != 1 {
			return false, fmt.Sprintf("containers=%d", len(pod.Containers))
		}
		agent := pod.Containers[0]
		if agent.Image != "ghcr.io/gameplanepanel/gameplane/repo-agent:test" || agent.ImagePullPolicy != corev1.PullAlways {
			return false, fmt.Sprintf("image=%s policy=%s", agent.Image, agent.ImagePullPolicy)
		}
		for _, arg := range []string{
			"--mode=repository",
			"--data-root=/repo",
			"--tls-cert=/etc/gameplane/agent-tls/tls.crt",
			"--tls-key=/etc/gameplane/agent-tls/tls.key",
			"--tls-client-ca=/etc/gameplane/agent-tls/ca.crt",
		} {
			if !slices.Contains(agent.Args, arg) {
				return false, fmt.Sprintf("args %v missing %s", agent.Args, arg)
			}
		}
		if !slices.ContainsFunc(agent.VolumeMounts, func(mount corev1.VolumeMount) bool {
			return mount.Name == "data" && mount.MountPath == "/repo"
		}) {
			return false, fmt.Sprintf("mounts %v", agent.VolumeMounts)
		}
		if !slices.ContainsFunc(pod.Volumes, func(volume corev1.Volume) bool {
			return volume.Secret != nil && volume.Secret.SecretName == "lfln-agent-tls"
		}) {
			return false, "agent tls volume missing"
		}
		if pod.AutomountServiceAccountToken == nil || *pod.AutomountServiceAccountToken {
			return false, "service account token must not be mounted"
		}
		if agent.SecurityContext == nil || agent.SecurityContext.RunAsNonRoot == nil || !*agent.SecurityContext.RunAsNonRoot {
			return false, "agent must run as non-root"
		}
		return isControlledBy(&sts, repo), "statefulset not owned by repository"
	})

	eventually(t, func() (bool, string) {
		var got gameplanev1alpha1.Repository
		if err := k8sClient.Get(ctx, client.ObjectKeyFromObject(repo), &got); err != nil {
			return false, err.Error()
		}
		if got.Status.Phase != gameplanev1alpha1.RepositoryPhasePending {
			return false, fmt.Sprintf("phase=%q", got.Status.Phase)
		}
		return meta.IsStatusConditionFalse(got.Status.Conditions, repositoryAgentCondition),
			fmt.Sprintf("conditions=%v", got.Status.Conditions)
	})
}

func TestRepository_DefaultStorageSize(t *testing.T) {
	ns := newNamespace(t)
	startMgr(t, ns, withRepositoryReconciler(t, ns))
	createRepository(t, ns, "defaults", nil)

	eventually(t, func() (bool, string) {
		var pvc corev1.PersistentVolumeClaim
		if err := k8sClient.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: "defaults-data"}, &pvc); err != nil {
			return false, err.Error()
		}
		size := pvc.Spec.Resources.Requests[corev1.ResourceStorage]
		return size.String() == "2Gi", fmt.Sprintf("size=%s", size.String())
	})
}

func TestRepository_AgentReadyKeepsExternalPhase(t *testing.T) {
	ns := newNamespace(t)
	startMgr(t, ns, withRepositoryReconciler(t, ns))
	repo := createRepository(t, ns, "ready", nil)
	ctx := context.Background()

	eventually(t, func() (bool, string) {
		var got gameplanev1alpha1.Repository
		if err := k8sClient.Get(ctx, client.ObjectKeyFromObject(repo), &got); err != nil {
			return false, err.Error()
		}
		return got.Status.Phase == gameplanev1alpha1.RepositoryPhasePending, fmt.Sprintf("phase=%q", got.Status.Phase)
	})

	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var got gameplanev1alpha1.Repository
		if err := k8sClient.Get(ctx, client.ObjectKeyFromObject(repo), &got); err != nil {
			return err
		}
		got.Status.Phase = gameplanev1alpha1.RepositoryPhaseReady
		got.Status.Head = "0123456789abcdef0123456789abcdef01234567"
		return k8sClient.Status().Update(ctx, &got)
	}); err != nil {
		t.Fatalf("set external status: %v", err)
	}

	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var sts appsv1.StatefulSet
		if err := k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: "ready"}, &sts); err != nil {
			return err
		}
		sts.Status.Replicas = 1
		sts.Status.ReadyReplicas = 1
		return k8sClient.Status().Update(ctx, &sts)
	}); err != nil {
		t.Fatalf("mark statefulset ready: %v", err)
	}

	eventually(t, func() (bool, string) {
		var got gameplanev1alpha1.Repository
		if err := k8sClient.Get(ctx, client.ObjectKeyFromObject(repo), &got); err != nil {
			return false, err.Error()
		}
		if got.Status.Phase != gameplanev1alpha1.RepositoryPhaseReady || got.Status.Head == "" {
			return false, fmt.Sprintf("phase=%q head=%q", got.Status.Phase, got.Status.Head)
		}
		return meta.IsStatusConditionTrue(got.Status.Conditions, repositoryAgentCondition),
			fmt.Sprintf("conditions=%v", got.Status.Conditions)
	})
}

func TestRepository_RejectsNonGitHubURL(t *testing.T) {
	ns := newNamespace(t)
	repo := &gameplanev1alpha1.Repository{
		ObjectMeta: metav1.ObjectMeta{Name: "bad", Namespace: ns},
		Spec:       gameplanev1alpha1.RepositorySpec{URL: "https://gitlab.com/owner/repo"},
	}
	if err := k8sClient.Create(context.Background(), repo); err == nil {
		t.Fatal("expected a non-github.com URL to be rejected")
	}
}

func TestRepository_URLImmutable(t *testing.T) {
	ns := newNamespace(t)
	repo := createRepository(t, ns, "immutable", nil)
	repo.Spec.URL = "https://github.com/chunksmith/other"
	if err := k8sClient.Update(context.Background(), repo); err == nil {
		t.Fatal("expected spec.url change to be rejected")
	}
}
