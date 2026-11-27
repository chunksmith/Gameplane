package controller

import (
	"context"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

const (
	repositoryDataRoot       = "/repo"
	repositoryAgentCondition = "AgentReady"
	defaultBuildCacheSize    = "5Gi"
)

type RepositoryReconciler struct {
	client.Client
	Scheme *runtime.Scheme

	AgentImage              string
	AgentImagePullPolicy    string
	ImagePullSecrets        []corev1.LocalObjectReference
	AgentCASecretName       string
	AgentCASecretNamespace  string
	DefaultStorageClassName string
	BuildCacheSize          resource.Quantity
}

// +kubebuilder:rbac:groups=gameplane.local,resources=repositories,verbs=get;list;watch

func (r *RepositoryReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var repo gameplanev1alpha1.Repository
	if err := r.Get(ctx, req.NamespacedName, &repo); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !repo.DeletionTimestamp.IsZero() {
		return ctrl.Result{}, nil
	}
	if err := r.reconcilePVC(ctx, &repo); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile repository PVC: %w", err)
	}
	cacheRequeue, err := r.reconcileBuildCache(ctx, &repo)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile repository build cache: %w", err)
	}
	if err := ensureAgentTLS(ctx, r.Client, r.Scheme, r.AgentCASecretName, r.AgentCASecretNamespace, &repo); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile repository agent TLS: %w", err)
	}
	if err := r.reconcileService(ctx, &repo); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile repository agent Service: %w", err)
	}
	sts, err := r.reconcileStatefulSet(ctx, &repo)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile repository StatefulSet: %w", err)
	}
	return ctrl.Result{RequeueAfter: cacheRequeue}, r.reconcileStatus(ctx, &repo, sts)
}

func repositoryLabels(repo *gameplanev1alpha1.Repository) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":     "gameplane-repo",
		"app.kubernetes.io/instance": repo.Name,
	}
}

func repositoryStorageSize(repo *gameplanev1alpha1.Repository) resource.Quantity {
	if repo.Spec.Storage.Size.IsZero() {
		return resource.MustParse("2Gi")
	}
	return repo.Spec.Storage.Size
}

func (r *RepositoryReconciler) repositoryStorageClassName(repo *gameplanev1alpha1.Repository) *string {
	if repo.Spec.Storage.StorageClassName == nil && r.DefaultStorageClassName != "" {
		return &r.DefaultStorageClassName
	}
	return repo.Spec.Storage.StorageClassName
}

func (r *RepositoryReconciler) reconcilePVC(ctx context.Context, repo *gameplanev1alpha1.Repository) error {
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: repo.Name + "-data", Namespace: repo.Namespace},
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, pvc, func() error {
		if pvc.CreationTimestamp.IsZero() {
			pvc.Spec.AccessModes = []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce}
			pvc.Spec.Resources.Requests = corev1.ResourceList{corev1.ResourceStorage: repositoryStorageSize(repo)}
			pvc.Spec.StorageClassName = r.repositoryStorageClassName(repo)
		}
		return controllerutil.SetControllerReference(repo, pvc, r.Scheme)
	})
	return err
}

func (r *RepositoryReconciler) buildCacheSize() resource.Quantity {
	if r.BuildCacheSize.IsZero() {
		return resource.MustParse(defaultBuildCacheSize)
	}
	return r.BuildCacheSize
}

func (r *RepositoryReconciler) reconcileBuildCache(ctx context.Context, repo *gameplanev1alpha1.Repository) (time.Duration, error) {
	if requeue, err := r.clearBuildCache(ctx, repo); err != nil || requeue > 0 {
		return requeue, err
	}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: buildCachePVCName(repo.Name), Namespace: repo.Namespace},
	}
	err := r.Get(ctx, client.ObjectKeyFromObject(pvc), pvc)
	switch {
	case err == nil && !pvc.DeletionTimestamp.IsZero():
		return 5 * time.Second, nil
	case err != nil && !apierrors.IsNotFound(err):
		return 0, fmt.Errorf("get build cache PVC: %w", err)
	}
	_, err = controllerutil.CreateOrUpdate(ctx, r.Client, pvc, func() error {
		if pvc.CreationTimestamp.IsZero() {
			pvc.Spec.AccessModes = []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce}
			pvc.Spec.Resources.Requests = corev1.ResourceList{corev1.ResourceStorage: r.buildCacheSize()}
			pvc.Spec.StorageClassName = r.repositoryStorageClassName(repo)
		}
		return controllerutil.SetControllerReference(repo, pvc, r.Scheme)
	})
	if err != nil {
		return 0, fmt.Errorf("reconcile build cache PVC: %w", err)
	}
	return 0, nil
}

func clearCacheRequest(repo *gameplanev1alpha1.Repository) (time.Time, bool) {
	requested, parseErr := time.Parse(time.RFC3339, repo.Annotations[gameplanev1alpha1.RepositoryClearCacheAnnotation])
	pending := repo.Status.CacheClearedAt == nil || requested.After(repo.Status.CacheClearedAt.Time)
	return requested, parseErr == nil && pending
}

func (r *RepositoryReconciler) clearBuildCache(ctx context.Context, repo *gameplanev1alpha1.Repository) (time.Duration, error) {
	requested, ok := clearCacheRequest(repo)
	if !ok {
		return 0, nil
	}
	var builds gameplanev1alpha1.RepositoryBuildList
	if err := r.List(ctx, &builds, client.InNamespace(repo.Namespace),
		client.MatchingLabels{gameplanev1alpha1.RepositoryLabel: repo.Name}); err != nil {
		return 0, fmt.Errorf("list repository builds: %w", err)
	}
	for i := range builds.Items {
		if !buildPhaseTerminal(builds.Items[i].Status.Phase) {
			return 10 * time.Second, nil
		}
	}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: buildCachePVCName(repo.Name), Namespace: repo.Namespace},
	}
	if err := r.Delete(ctx, pvc); client.IgnoreNotFound(err) != nil {
		return 0, fmt.Errorf("delete build cache PVC: %w", err)
	}
	base := repo.DeepCopy()
	repo.Status.CacheClearedAt = &metav1.Time{Time: requested}
	if err := r.Status().Patch(ctx, repo, client.MergeFrom(base)); err != nil {
		return 0, fmt.Errorf("patch repository cache status: %w", err)
	}
	return 0, nil
}

func (r *RepositoryReconciler) reconcileService(ctx context.Context, repo *gameplanev1alpha1.Repository) error {
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: repo.Name + "-agent", Namespace: repo.Namespace},
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, svc, func() error {
		svc.Spec.Type = corev1.ServiceTypeClusterIP
		svc.Spec.PublishNotReadyAddresses = true
		svc.Spec.Selector = repositoryLabels(repo)
		svc.Spec.Ports = []corev1.ServicePort{{
			Name:       "agent",
			Port:       8090,
			TargetPort: intstr.FromInt32(8090),
			Protocol:   corev1.ProtocolTCP,
		}}
		return controllerutil.SetControllerReference(repo, svc, r.Scheme)
	})
	return err
}

func (r *RepositoryReconciler) reconcileStatefulSet(
	ctx context.Context, repo *gameplanev1alpha1.Repository,
) (*appsv1.StatefulSet, error) {
	sts := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: repo.Name, Namespace: repo.Namespace},
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, sts, func() error {
		labels := repositoryLabels(repo)
		replicas := int32(1)
		fsGroup := int64(65532)
		automount := false
		sts.Labels = labels
		sts.Spec.Replicas = &replicas
		sts.Spec.ServiceName = repo.Name + "-agent"
		sts.Spec.Selector = &metav1.LabelSelector{MatchLabels: labels}
		sts.Spec.Template.Labels = labels
		sts.Spec.Template.Spec.AutomountServiceAccountToken = &automount
		sts.Spec.Template.Spec.SecurityContext = &corev1.PodSecurityContext{FSGroup: &fsGroup}
		sts.Spec.Template.Spec.ImagePullSecrets = r.ImagePullSecrets
		sts.Spec.Template.Spec.Containers = []corev1.Container{r.buildRepositoryAgentContainer(repo)}
		sts.Spec.Template.Spec.Volumes = []corev1.Volume{
			{
				Name: "data",
				VolumeSource: corev1.VolumeSource{
					PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: repo.Name + "-data"},
				},
			},
			{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
			agentTLSVolume(repo.Name),
		}
		return controllerutil.SetControllerReference(repo, sts, r.Scheme)
	})
	return sts, err
}

func (r *RepositoryReconciler) buildRepositoryAgentContainer(repo *gameplanev1alpha1.Repository) corev1.Container {
	size := repositoryStorageSize(repo)
	c := corev1.Container{
		Name:  "agent",
		Image: r.AgentImage,
		Args:  append(agentTLSArgs(), "--mode=repository", "--data-root="+repositoryDataRoot),
		Env: []corev1.EnvVar{
			{Name: "GAMEPLANE_SERVER_NAME", Value: repo.Name},
			{Name: "GAMEPLANE_SERVER_UID", Value: string(repo.UID)},
			{Name: "GAMEPLANE_RCON_ENABLED", Value: "false"},
			{Name: "GAMEPLANE_HEARTBEAT", Value: "false"},
			{Name: "GAMEPLANE_DISK_LIMIT_BYTES", Value: fmt.Sprint(size.Value())},
			{Name: "HOME", Value: "/tmp"},
		},
		VolumeMounts: []corev1.VolumeMount{
			{Name: "data", MountPath: repositoryDataRoot},
			{Name: "tmp", MountPath: "/tmp"},
			agentTLSVolumeMount(),
		},
		Ports: []corev1.ContainerPort{
			{Name: "agent", ContainerPort: 8090},
			{Name: "metrics", ContainerPort: 9090},
		},
		SecurityContext: agentSecurityContext(),
	}
	if r.AgentImagePullPolicy != "" {
		c.ImagePullPolicy = corev1.PullPolicy(r.AgentImagePullPolicy)
	}
	return c
}

func (r *RepositoryReconciler) reconcileStatus(
	ctx context.Context, repo *gameplanev1alpha1.Repository, sts *appsv1.StatefulSet,
) error {
	base := repo.DeepCopy()
	if repo.Status.Phase == "" {
		repo.Status.Phase = gameplanev1alpha1.RepositoryPhasePending
	}
	ready := metav1.Condition{
		Type:               repositoryAgentCondition,
		Status:             metav1.ConditionFalse,
		Reason:             "AgentNotReady",
		Message:            "repository agent pod is not ready",
		ObservedGeneration: repo.Generation,
	}
	if sts.Status.ReadyReplicas > 0 {
		ready.Status, ready.Reason, ready.Message = metav1.ConditionTrue, "AgentReady", "repository agent pod is ready"
	}
	meta.SetStatusCondition(&repo.Status.Conditions, ready)
	if equality.Semantic.DeepEqual(base.Status, repo.Status) {
		return nil
	}
	if err := r.Status().Patch(ctx, repo, client.MergeFrom(base)); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("patch repository status: %w", err)
	}
	return nil
}

func (r *RepositoryReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&gameplanev1alpha1.Repository{}).
		Owns(&appsv1.StatefulSet{}).
		Owns(&corev1.Service{}).
		Owns(&corev1.PersistentVolumeClaim{}).
		Owns(&corev1.Secret{}).
		Complete(r)
}
