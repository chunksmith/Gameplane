package controller

import (
	"bufio"
	"cmp"
	"context"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

const (
	buildContainerName      = "build"
	buildScriptMount        = "/etc/gameplane-build"
	buildCacheMount         = "/cache"
	buildRepoMount          = "/repo"
	buildPollInterval       = 5 * time.Second
	buildQueueInterval      = 10 * time.Second
	buildLogGracePeriod     = 2 * time.Minute
	defaultMavenBuildArgs   = "-B clean package"
	defaultGradleBuildArgs  = "build"
	mavenReadSecretName     = "gameplane-maven-read"
	mavenWriteSecretName    = "gameplane-maven-write"
	buildJobCreatedCondType = "JobCreated"
	buildPublishedCondType  = "Published"
	buildUID                = 65532
	buildSecretDefaultMode  = 0444
)

type BuildLogReader interface {
	BuildLogs(ctx context.Context, namespace, jobName string) (io.ReadCloser, error)
}

type RepositoryBuildReconciler struct {
	client.Client
	APIReader client.Reader
	Scheme    *runtime.Scheme
	Clientset kubernetes.Interface
	LogReader BuildLogReader

	MavenImage     string
	GradleImage    string
	Resources      corev1.ResourceRequirements
	Deadline       int64
	Keep           int
	MavenURL       string
	MavenNamespace string
}

// +kubebuilder:rbac:groups=gameplane.local,resources=repositorybuilds,verbs=get;list;watch
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=pods/log,verbs=get

func (r *RepositoryBuildReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var build gameplanev1alpha1.RepositoryBuild
	if err := r.Get(ctx, req.NamespacedName, &build); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !build.DeletionTimestamp.IsZero() {
		return ctrl.Result{}, nil
	}
	if buildPhaseTerminal(build.Status.Phase) {
		return ctrl.Result{}, r.keepRecentBuilds(ctx, &build)
	}
	if result, waiting, err := r.waitForTurn(ctx, &build); err != nil || waiting {
		return result, err
	}
	if err := r.ensureSecret(ctx, &build); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile build Secret: %w", err)
	}
	job, err := r.ensureJob(ctx, &build)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile build Job: %w", err)
	}
	return r.mirrorJobStatus(ctx, &build, job)
}

func (r *RepositoryBuildReconciler) reader() client.Reader {
	if r.APIReader != nil {
		return r.APIReader
	}
	return r.Client
}

func (r *RepositoryBuildReconciler) waitForTurn(
	ctx context.Context, build *gameplanev1alpha1.RepositoryBuild,
) (ctrl.Result, bool, error) {
	number := buildNumber(build)
	var list gameplanev1alpha1.RepositoryBuildList
	if err := r.reader().List(ctx, &list, client.InNamespace(build.Namespace),
		client.MatchingLabels{gameplanev1alpha1.RepositoryLabel: build.Spec.RepositoryRef}); err != nil {
		return ctrl.Result{}, false, fmt.Errorf("list repository builds: %w", err)
	}
	var blocker int64
	blocked := false
	for i := range list.Items {
		other := &list.Items[i]
		n := buildNumber(other)
		if other.Name == build.Name || n >= number || buildPhaseTerminal(other.Status.Phase) || !other.DeletionTimestamp.IsZero() {
			continue
		}
		if !blocked || n < blocker {
			blocker, blocked = n, true
		}
	}
	if !blocked {
		return ctrl.Result{}, false, nil
	}
	msg := fmt.Sprintf("waiting for build #%d", blocker)
	if build.Status.Phase != gameplanev1alpha1.BuildPhaseQueued || build.Status.Message != msg {
		base := build.DeepCopy()
		build.Status.Phase = gameplanev1alpha1.BuildPhaseQueued
		build.Status.Message = msg
		if err := r.Status().Patch(ctx, build, client.MergeFrom(base)); err != nil {
			return ctrl.Result{}, false, fmt.Errorf("patch queued build status: %w", err)
		}
	}
	return ctrl.Result{RequeueAfter: buildQueueInterval}, true, nil
}

func (r *RepositoryBuildReconciler) ensureSecret(ctx context.Context, build *gameplanev1alpha1.RepositoryBuild) error {
	data, err := r.buildSecretData(ctx, build)
	if err != nil {
		return err
	}
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: build.Name, Namespace: build.Namespace}}
	_, err = controllerutil.CreateOrUpdate(ctx, r.Client, secret, func() error {
		secret.Data = data
		return controllerutil.SetControllerReference(build, secret, r.Scheme)
	})
	return err
}

func (r *RepositoryBuildReconciler) buildSecretData(
	ctx context.Context, build *gameplanev1alpha1.RepositoryBuild,
) (map[string][]byte, error) {
	data := map[string][]byte{
		"build.sh":         []byte(renderBuildScript(build.Spec.Tool)),
		"settings.xml":     []byte(renderMavenSettings(r.MavenURL != "")),
		"gameplane.gradle": []byte(renderGradleInit()),
	}
	if r.MavenURL == "" {
		return data, nil
	}
	if err := r.copyMavenCredentials(ctx, data, mavenReadSecretName, "read"); err != nil {
		return nil, err
	}
	if build.Spec.Publish {
		if err := r.copyMavenCredentials(ctx, data, mavenWriteSecretName, "write"); err != nil {
			return nil, err
		}
	}
	return data, nil
}

func (r *RepositoryBuildReconciler) copyMavenCredentials(
	ctx context.Context, data map[string][]byte, secretName, prefix string,
) error {
	var secret corev1.Secret
	err := r.reader().Get(ctx, types.NamespacedName{Namespace: r.MavenNamespace, Name: secretName}, &secret)
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("get %s Secret: %w", secretName, err)
	}
	for _, key := range []string{"username", "token"} {
		if value, ok := secret.Data[key]; ok {
			data[prefix+"-"+key] = value
		}
	}
	return nil
}

func (r *RepositoryBuildReconciler) ensureJob(
	ctx context.Context, build *gameplanev1alpha1.RepositoryBuild,
) (*batchv1.Job, error) {
	key := types.NamespacedName{Namespace: build.Namespace, Name: truncateDNS(build.Name, 63)}
	var existing batchv1.Job
	err := r.reader().Get(ctx, key, &existing)
	if err == nil {
		return &existing, nil
	}
	if !apierrors.IsNotFound(err) {
		return nil, fmt.Errorf("get build Job: %w", err)
	}
	job := r.newBuildJob(build, key.Name)
	if err := controllerutil.SetControllerReference(build, job, r.Scheme); err != nil {
		return nil, fmt.Errorf("set build Job owner: %w", err)
	}
	if err := r.Create(ctx, job); err != nil {
		return nil, fmt.Errorf("create build Job: %w", err)
	}
	return job, nil
}

func (r *RepositoryBuildReconciler) newBuildJob(build *gameplanev1alpha1.RepositoryBuild, name string) *batchv1.Job {
	repo := build.Spec.RepositoryRef
	labels := buildLabels(build)
	env := []corev1.EnvVar{
		{Name: "HOME", Value: "/tmp"},
		{Name: "GRADLE_USER_HOME", Value: buildCacheMount + "/gradle"},
		{Name: "MAVEN_OPTS", Value: "-Dmaven.repo.local=" + buildCacheMount + "/m2"},
		{Name: "GAMEPLANE_MAVEN_URL", Value: r.MavenURL},
		{Name: "BUILD_TOOL", Value: string(build.Spec.Tool)},
		{Name: "BUILD_ARGS", Value: buildArgs(build)},
		{Name: "BUILD_PUBLISH", Value: strconv.FormatBool(build.Spec.Publish)},
		buildSecretEnv("GAMEPLANE_MAVEN_USER", build.Name, "read-username"),
		buildSecretEnv("GAMEPLANE_MAVEN_READ_TOKEN", build.Name, "read-token"),
	}
	if build.Spec.Publish {
		env = append(env,
			buildSecretEnv("GAMEPLANE_MAVEN_WRITE_USER", build.Name, "write-username"),
			buildSecretEnv("GAMEPLANE_MAVEN_WRITE_TOKEN", build.Name, "write-token"),
		)
	}
	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: build.Namespace, Labels: labels},
		Spec: batchv1.JobSpec{
			BackoffLimit:          ptr.To(int32(0)),
			ActiveDeadlineSeconds: ptr.To(r.Deadline),
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					RestartPolicy:                corev1.RestartPolicyNever,
					AutomountServiceAccountToken: ptr.To(false),
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot:   ptr.To(true),
						RunAsUser:      ptr.To(int64(buildUID)),
						RunAsGroup:     ptr.To(int64(buildUID)),
						FSGroup:        ptr.To(int64(buildUID)),
						SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
					},
					Affinity: &corev1.Affinity{PodAffinity: &corev1.PodAffinity{
						RequiredDuringSchedulingIgnoredDuringExecution: []corev1.PodAffinityTerm{{
							LabelSelector: &metav1.LabelSelector{MatchLabels: map[string]string{
								"app.kubernetes.io/name":     "gameplane-repo",
								"app.kubernetes.io/instance": repo,
							}},
							TopologyKey: "kubernetes.io/hostname",
						}},
					}},
					Containers: []corev1.Container{{
						Name:       buildContainerName,
						Image:      r.buildImage(build),
						Command:    []string{"/bin/sh", buildScriptMount + "/build.sh"},
						WorkingDir: buildRepoMount,
						Env:        env,
						Resources:  r.Resources,
						VolumeMounts: []corev1.VolumeMount{
							{Name: "repo", MountPath: buildRepoMount},
							{Name: "cache", MountPath: buildCacheMount},
							{Name: "build", MountPath: buildScriptMount, ReadOnly: true},
							{Name: "tmp", MountPath: "/tmp"},
						},
						SecurityContext: &corev1.SecurityContext{
							ReadOnlyRootFilesystem:   ptr.To(true),
							AllowPrivilegeEscalation: ptr.To(false),
							Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
						},
					}},
					Volumes: []corev1.Volume{
						{Name: "repo", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: repo + "-data"}}},
						{Name: "cache", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: buildCachePVCName(repo)}}},
						{Name: "build", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: build.Name, DefaultMode: ptr.To(int32(buildSecretDefaultMode))}}},
						{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
					},
				},
			},
		},
	}
}

func (r *RepositoryBuildReconciler) buildImage(build *gameplanev1alpha1.RepositoryBuild) string {
	image := r.MavenImage
	if build.Spec.Tool == gameplanev1alpha1.BuildToolGradle {
		image = r.GradleImage
	}
	return strings.ReplaceAll(image, "{jdk}", strconv.Itoa(int(build.Spec.JDK)))
}

func buildCachePVCName(repo string) string {
	return repo + "-build-cache"
}

func buildSecretEnv(name, secret, key string) corev1.EnvVar {
	return corev1.EnvVar{Name: name, ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
		LocalObjectReference: corev1.LocalObjectReference{Name: secret},
		Key:                  key,
		Optional:             ptr.To(true),
	}}}
}

func buildLabels(build *gameplanev1alpha1.RepositoryBuild) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":                     "gameplane-build",
		"app.kubernetes.io/instance":                 build.Spec.RepositoryRef,
		gameplanev1alpha1.RepositoryBuildNumberLabel: build.Labels[gameplanev1alpha1.RepositoryBuildNumberLabel],
	}
}

func buildArgs(build *gameplanev1alpha1.RepositoryBuild) string {
	if build.Spec.Args != "" {
		return build.Spec.Args
	}
	if build.Spec.Tool == gameplanev1alpha1.BuildToolGradle {
		return defaultGradleBuildArgs
	}
	return defaultMavenBuildArgs
}

func (r *RepositoryBuildReconciler) mirrorJobStatus(
	ctx context.Context, build *gameplanev1alpha1.RepositoryBuild, job *batchv1.Job,
) (ctrl.Result, error) {
	base := build.DeepCopy()
	build.Status.Tool = resolvedBuildTool(build.Spec.Tool)
	build.Status.Resources = r.Resources
	build.Status.Conditions = upsertCondition(build.Status.Conditions, metav1.Condition{
		Type:    buildJobCreatedCondType,
		Status:  metav1.ConditionTrue,
		Reason:  "JobCreated",
		Message: "build Job exists",
	})
	if job.Status.StartTime != nil && build.Status.StartTime == nil {
		build.Status.StartTime = job.Status.StartTime
	}
	result := ctrl.Result{}
	switch {
	case job.Status.Succeeded > 0:
		if err := r.recordSucceeded(ctx, build, job); err != nil {
			log.FromContext(ctx).Error(err, "read build log", "job", job.Name)
			if !buildLogGraceExpired(job) {
				return ctrl.Result{RequeueAfter: buildPollInterval}, nil
			}
			recordLogUnavailable(build, job)
		}
	case jobPermanentlyFailed(job):
		build.Status.Phase = gameplanev1alpha1.BuildPhaseFailed
		build.Status.Message = jobFailureMessage(job)
		build.Status.CompletionTime = jobCompletionTime(job)
	case job.Status.Ready != nil && *job.Status.Ready > 0:
		build.Status.Phase = gameplanev1alpha1.BuildPhaseRunning
		build.Status.Message = ""
		result.RequeueAfter = buildPollInterval
	default:
		build.Status.Phase = gameplanev1alpha1.BuildPhasePending
		build.Status.Message = ""
		result.RequeueAfter = buildPollInterval
	}
	if err := r.Status().Patch(ctx, build, client.MergeFrom(base)); err != nil && !apierrors.IsNotFound(err) {
		return ctrl.Result{}, fmt.Errorf("patch build status: %w", err)
	}
	return result, nil
}

func (r *RepositoryBuildReconciler) recordSucceeded(
	ctx context.Context, build *gameplanev1alpha1.RepositoryBuild, job *batchv1.Job,
) error {
	reader, err := r.logs().BuildLogs(ctx, build.Namespace, job.Name)
	if err != nil {
		return fmt.Errorf("read build logs: %w", err)
	}
	defer reader.Close()
	artifacts, published, cacheBytes := ParseBuildMarkers(reader)
	build.Status.Phase = gameplanev1alpha1.BuildPhaseSucceeded
	build.Status.Message = ""
	build.Status.Artifacts = artifacts
	build.Status.Published = published
	build.Status.CacheBytes = cacheBytes
	build.Status.CompletionTime = jobCompletionTime(job)
	if build.Spec.Publish {
		condition := metav1.Condition{
			Type:    buildPublishedCondType,
			Status:  metav1.ConditionTrue,
			Reason:  "Published",
			Message: "artifacts were published to the Gameplane repository",
		}
		if !published {
			condition.Status, condition.Reason = metav1.ConditionFalse, "NotPublished"
			condition.Message = "artifacts were not published to the Gameplane repository"
		}
		build.Status.Conditions = upsertCondition(build.Status.Conditions, condition)
	}
	return nil
}

func buildLogGraceExpired(job *batchv1.Job) bool {
	return job.Status.CompletionTime != nil && time.Since(job.Status.CompletionTime.Time) > buildLogGracePeriod
}

func recordLogUnavailable(build *gameplanev1alpha1.RepositoryBuild, job *batchv1.Job) {
	build.Status.Phase = gameplanev1alpha1.BuildPhaseSucceeded
	build.Status.Message = "build log unavailable; artifacts unknown"
	build.Status.Artifacts = nil
	build.Status.Published = false
	build.Status.CompletionTime = jobCompletionTime(job)
}

func resolvedBuildTool(tool gameplanev1alpha1.BuildTool) gameplanev1alpha1.BuildTool {
	if tool == gameplanev1alpha1.BuildToolAuto {
		return gameplanev1alpha1.BuildToolMaven
	}
	return tool
}

func (r *RepositoryBuildReconciler) logs() BuildLogReader {
	if r.LogReader != nil {
		return r.LogReader
	}
	return &clientsetBuildLogReader{cs: r.Clientset}
}

func (r *RepositoryBuildReconciler) keepRecentBuilds(ctx context.Context, build *gameplanev1alpha1.RepositoryBuild) error {
	var list gameplanev1alpha1.RepositoryBuildList
	if err := r.reader().List(ctx, &list, client.InNamespace(build.Namespace),
		client.MatchingLabels{gameplanev1alpha1.RepositoryLabel: build.Spec.RepositoryRef}); err != nil {
		return fmt.Errorf("list repository builds: %w", err)
	}
	terminal := make([]*gameplanev1alpha1.RepositoryBuild, 0, len(list.Items))
	for i := range list.Items {
		item := &list.Items[i]
		if buildPhaseTerminal(item.Status.Phase) && item.DeletionTimestamp.IsZero() {
			terminal = append(terminal, item)
		}
	}
	slices.SortFunc(terminal, func(a, b *gameplanev1alpha1.RepositoryBuild) int {
		return cmp.Compare(buildNumber(b), buildNumber(a))
	})
	keep := min(max(r.Keep, 0), len(terminal))
	for _, old := range terminal[keep:] {
		if err := r.Delete(ctx, old, client.PropagationPolicy(metav1.DeletePropagationBackground)); client.IgnoreNotFound(err) != nil {
			return fmt.Errorf("delete build %s: %w", old.Name, err)
		}
	}
	return nil
}

func (r *RepositoryBuildReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if r.APIReader == nil {
		r.APIReader = mgr.GetAPIReader()
	}
	return ctrl.NewControllerManagedBy(mgr).
		For(&gameplanev1alpha1.RepositoryBuild{}).
		Owns(&batchv1.Job{}).
		Owns(&corev1.Secret{}).
		Complete(r)
}

func buildPhaseTerminal(phase gameplanev1alpha1.BuildPhase) bool {
	return phase == gameplanev1alpha1.BuildPhaseSucceeded || phase == gameplanev1alpha1.BuildPhaseFailed
}

func buildNumber(build *gameplanev1alpha1.RepositoryBuild) int64 {
	n, _ := strconv.ParseInt(build.Labels[gameplanev1alpha1.RepositoryBuildNumberLabel], 10, 64)
	return n
}

func jobCompletionTime(job *batchv1.Job) *metav1.Time {
	if job.Status.CompletionTime != nil {
		return job.Status.CompletionTime
	}
	now := metav1.Now()
	return &now
}

func ParseBuildMarkers(reader io.Reader) ([]gameplanev1alpha1.BuildArtifact, bool, int64) {
	var artifacts []gameplanev1alpha1.BuildArtifact
	var published bool
	var cacheBytes int64
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "::artifact::":
			if len(fields) < 4 {
				continue
			}
			size, err := strconv.ParseInt(fields[2], 10, 64)
			if err != nil {
				continue
			}
			artifacts = append(artifacts, gameplanev1alpha1.BuildArtifact{
				Path:   fields[1],
				Size:   size,
				SHA256: fields[3],
				Shaded: len(fields) >= 5 && fields[4] == "shaded",
			})
		case "::published::":
			published = len(fields) > 1 && fields[1] == "true"
		case "::cache::":
			if len(fields) > 1 {
				if n, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
					cacheBytes = n
				}
			}
		}
	}
	return artifacts, published, cacheBytes
}

type clientsetBuildLogReader struct {
	cs kubernetes.Interface
}

func (l *clientsetBuildLogReader) BuildLogs(ctx context.Context, namespace, jobName string) (io.ReadCloser, error) {
	pods, err := l.cs.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: "job-name=" + jobName})
	if err != nil {
		return nil, fmt.Errorf("list build pods: %w", err)
	}
	if len(pods.Items) == 0 {
		return nil, fmt.Errorf("no build pod for job %s yet", jobName)
	}
	newest := &pods.Items[0]
	for i := range pods.Items {
		if pods.Items[i].CreationTimestamp.After(newest.CreationTimestamp.Time) {
			newest = &pods.Items[i]
		}
	}
	return l.cs.CoreV1().Pods(namespace).GetLogs(newest.Name, &corev1.PodLogOptions{Container: buildContainerName}).Stream(ctx)
}
