//go:build envtest

package controller

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
	"testing"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/manager"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

type fakeBuildLogReader struct {
	body string
}

func (f *fakeBuildLogReader) BuildLogs(_ context.Context, _, _ string) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader(f.body)), nil
}

func withRepositoryBuildReconciler(ns string, logs BuildLogReader) setupReconciler {
	return func(mgr manager.Manager) error {
		return (&RepositoryBuildReconciler{
			Client:         mgr.GetClient(),
			APIReader:      mgr.GetAPIReader(),
			Scheme:         mgr.GetScheme(),
			LogReader:      logs,
			MavenImage:     "maven:3.9.11-eclipse-temurin-{jdk}",
			GradleImage:    "gradle:9.9.2-jdk{jdk}",
			Deadline:       1800,
			Keep:           10,
			MavenURL:       "http://gameplane-maven.gameplane-system.svc:8080",
			MavenNamespace: ns,
		}).SetupWithManager(mgr)
	}
}

func createRepositoryBuild(t *testing.T, ns, repo string, number int, publish bool) *gameplanev1alpha1.RepositoryBuild {
	t.Helper()
	build := &gameplanev1alpha1.RepositoryBuild{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("%s-build-%d", repo, number),
			Namespace: ns,
			Labels: map[string]string{
				gameplanev1alpha1.RepositoryLabel:            repo,
				gameplanev1alpha1.RepositoryBuildNumberLabel: strconv.Itoa(number),
			},
		},
		Spec: gameplanev1alpha1.RepositoryBuildSpec{
			RepositoryRef: repo,
			Tool:          gameplanev1alpha1.BuildToolMaven,
			JDK:           21,
			Publish:       publish,
		},
	}
	if err := k8sClient.Create(context.Background(), build); err != nil {
		t.Fatalf("create RepositoryBuild: %v", err)
	}
	return build
}

func createMavenSecrets(t *testing.T, ns string) {
	t.Helper()
	secrets := map[string]map[string][]byte{
		mavenReadSecretName:  {"username": []byte("reader"), "token": []byte("read-secret")},
		mavenWriteSecretName: {"username": []byte("writer"), "token": []byte("write-secret")},
	}
	for name, data := range secrets {
		secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}, Data: data}
		if err := k8sClient.Create(context.Background(), secret); err != nil {
			t.Fatalf("create Secret %s: %v", name, err)
		}
	}
}

func getBuildJob(ns, name string) (*batchv1.Job, error) {
	var job batchv1.Job
	err := k8sClient.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: name}, &job)
	return &job, err
}

func TestRepositoryBuild_JobHardening(t *testing.T) {
	ns := newNamespace(t)
	createMavenSecrets(t, ns)
	startMgr(t, ns, withRepositoryBuildReconciler(ns, &fakeBuildLogReader{}))
	createRepositoryBuild(t, ns, "lfln", 1, true)

	var job *batchv1.Job
	eventually(t, func() (bool, string) {
		j, err := getBuildJob(ns, "lfln-build-1")
		job = j
		return err == nil, fmt.Sprint(err)
	})

	if job.Spec.BackoffLimit == nil || *job.Spec.BackoffLimit != 0 {
		t.Fatalf("backoffLimit = %v, want 0", job.Spec.BackoffLimit)
	}
	if job.Spec.ActiveDeadlineSeconds == nil || *job.Spec.ActiveDeadlineSeconds != 1800 {
		t.Fatalf("activeDeadlineSeconds = %v, want 1800", job.Spec.ActiveDeadlineSeconds)
	}
	pod := job.Spec.Template.Spec
	if pod.AutomountServiceAccountToken == nil || *pod.AutomountServiceAccountToken {
		t.Fatalf("automountServiceAccountToken must be false")
	}
	if pod.Affinity == nil || pod.Affinity.PodAffinity == nil || len(pod.Affinity.PodAffinity.RequiredDuringSchedulingIgnoredDuringExecution) != 1 {
		t.Fatalf("missing required podAffinity: %+v", pod.Affinity)
	}
	term := pod.Affinity.PodAffinity.RequiredDuringSchedulingIgnoredDuringExecution[0]
	if term.TopologyKey != "kubernetes.io/hostname" || term.LabelSelector.MatchLabels["app.kubernetes.io/name"] != "gameplane-repo" || term.LabelSelector.MatchLabels["app.kubernetes.io/instance"] != "lfln" {
		t.Fatalf("affinity term = %+v", term)
	}
	if pod.SecurityContext == nil || pod.SecurityContext.RunAsNonRoot == nil || !*pod.SecurityContext.RunAsNonRoot || *pod.SecurityContext.RunAsUser != 65532 {
		t.Fatalf("pod security context = %+v", pod.SecurityContext)
	}
	container := pod.Containers[0]
	if container.Name != "build" || container.SecurityContext == nil || !*container.SecurityContext.ReadOnlyRootFilesystem || *container.SecurityContext.AllowPrivilegeEscalation {
		t.Fatalf("container security context = %+v", container.SecurityContext)
	}
	if job.Labels["app.kubernetes.io/name"] != "gameplane-build" || job.Labels[gameplanev1alpha1.RepositoryBuildNumberLabel] != "1" {
		t.Fatalf("job labels = %v", job.Labels)
	}
}

func TestRepositoryBuild_WriteTokenOnlyWhenPublishing(t *testing.T) {
	ns := newNamespace(t)
	createMavenSecrets(t, ns)
	startMgr(t, ns, withRepositoryBuildReconciler(ns, &fakeBuildLogReader{}))
	createRepositoryBuild(t, ns, "pub", 1, true)
	createRepositoryBuild(t, ns, "dry", 1, false)

	readSecret := func(name string) (*corev1.Secret, error) {
		var secret corev1.Secret
		err := k8sClient.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: name}, &secret)
		return &secret, err
	}
	eventually(t, func() (bool, string) {
		secret, err := readSecret("pub-build-1")
		if err != nil {
			return false, err.Error()
		}
		_, ok := secret.Data["write-token"]
		return ok, fmt.Sprint(secret.Data)
	})
	eventually(t, func() (bool, string) {
		secret, err := readSecret("dry-build-1")
		if err != nil {
			return false, err.Error()
		}
		_, hasRead := secret.Data["read-token"]
		return hasRead, fmt.Sprint(secret.Data)
	})
	secret, err := readSecret("dry-build-1")
	if err != nil {
		t.Fatalf("get dry secret: %v", err)
	}
	if _, ok := secret.Data["write-token"]; ok {
		t.Fatalf("non-publishing build must not carry the write token")
	}
	for _, key := range []string{"build.sh", "settings.xml", "gameplane.gradle"} {
		if _, ok := secret.Data[key]; !ok {
			t.Fatalf("build Secret missing key %s", key)
		}
	}
}

func TestRepositoryBuild_QueuesBehindLowerNumber(t *testing.T) {
	ns := newNamespace(t)
	startMgr(t, ns, withRepositoryBuildReconciler(ns, &fakeBuildLogReader{}))
	createRepositoryBuild(t, ns, "lfln", 1, false)
	createRepositoryBuild(t, ns, "lfln", 2, false)

	eventually(t, func() (bool, string) {
		var second gameplanev1alpha1.RepositoryBuild
		if err := k8sClient.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: "lfln-build-2"}, &second); err != nil {
			return false, err.Error()
		}
		return second.Status.Phase == gameplanev1alpha1.BuildPhaseQueued && second.Status.Message == "waiting for build #1",
			fmt.Sprintf("phase=%q message=%q", second.Status.Phase, second.Status.Message)
	})
}

func TestRepositoryBuild_MirrorsSucceededStatus(t *testing.T) {
	ns := newNamespace(t)
	createMavenSecrets(t, ns)
	logs := &fakeBuildLogReader{body: "::artifact:: target/app.jar 42 abc123\n::published:: true\n::cache:: 1024\n"}
	startMgr(t, ns, withRepositoryBuildReconciler(ns, logs))
	createRepositoryBuild(t, ns, "lfln", 1, true)

	eventually(t, func() (bool, string) {
		_, err := getBuildJob(ns, "lfln-build-1")
		return err == nil, fmt.Sprint(err)
	})
	job, err := getBuildJob(ns, "lfln-build-1")
	if err != nil {
		t.Fatalf("get job: %v", err)
	}
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		current, err := getBuildJob(ns, job.Name)
		if err != nil {
			return err
		}
		current.Status.Succeeded = 1
		current.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
		now := metav1.Now()
		current.Status.CompletionTime = &now
		return k8sClient.Status().Update(context.Background(), current)
	})
	if err != nil {
		t.Fatalf("mark Job succeeded: %v", err)
	}

	eventually(t, func() (bool, string) {
		var build gameplanev1alpha1.RepositoryBuild
		if err := k8sClient.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: "lfln-build-1"}, &build); err != nil {
			return false, err.Error()
		}
		ok := build.Status.Phase == gameplanev1alpha1.BuildPhaseSucceeded &&
			len(build.Status.Artifacts) == 1 && build.Status.Published && build.Status.CacheBytes == 1024
		return ok, fmt.Sprintf("phase=%q artifacts=%d published=%v cache=%d",
			build.Status.Phase, len(build.Status.Artifacts), build.Status.Published, build.Status.CacheBytes)
	})
}

func TestRepositoryBuild_RetentionKeepsNewestTerminal(t *testing.T) {
	ns := newNamespace(t)
	for number := 1; number <= 3; number++ {
		build := createRepositoryBuild(t, ns, "lfln", number, false)
		err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
			var current gameplanev1alpha1.RepositoryBuild
			if err := k8sClient.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: build.Name}, &current); err != nil {
				return err
			}
			current.Status.Phase = gameplanev1alpha1.BuildPhaseSucceeded
			return k8sClient.Status().Update(context.Background(), &current)
		})
		if err != nil {
			t.Fatalf("mark build %d succeeded: %v", number, err)
		}
	}

	newest := &gameplanev1alpha1.RepositoryBuild{}
	if err := k8sClient.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: "lfln-build-3"}, newest); err != nil {
		t.Fatalf("get newest build: %v", err)
	}
	r := &RepositoryBuildReconciler{Client: k8sClient, APIReader: k8sClient, Scheme: scheme, Keep: 2}
	if err := r.keepRecentBuilds(context.Background(), newest); err != nil {
		t.Fatalf("keepRecentBuilds: %v", err)
	}

	var list gameplanev1alpha1.RepositoryBuildList
	if err := k8sClient.List(context.Background(), &list, client.InNamespace(ns)); err != nil {
		t.Fatalf("list builds: %v", err)
	}
	names := map[string]bool{}
	for _, build := range list.Items {
		names[build.Name] = true
	}
	if names["lfln-build-1"] || !names["lfln-build-2"] || !names["lfln-build-3"] {
		t.Fatalf("remaining builds = %v, want build-2 and build-3", names)
	}
}
