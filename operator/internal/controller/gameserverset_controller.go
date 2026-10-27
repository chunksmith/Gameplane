package controller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

const (
	serverSetLabel          = "gameplane.local/server-set"
	serverSetHashAnnotation = "gameplane.local/server-set-hash"
)

var serverSetInheritedAnnotations = []string{
	"gameplane.local/owner-id",
	"gameplane.local/owner",
	"gameplane.local/network",
}

type GameServerSetReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=gameplane.local,resources=gameserversets,verbs=get;list;watch
// +kubebuilder:rbac:groups=gameplane.local,resources=gameservers,verbs=get;list;watch

func (r *GameServerSetReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var set gameplanev1alpha1.GameServerSet
	if err := r.Get(ctx, req.NamespacedName, &set); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !set.DeletionTimestamp.IsZero() {
		return ctrl.Result{}, nil
	}
	var children gameplanev1alpha1.GameServerList
	if err := r.List(ctx, &children, client.InNamespace(set.Namespace), client.MatchingLabels{serverSetLabel: set.Name}); err != nil {
		return ctrl.Result{}, fmt.Errorf("list set children: %w", err)
	}
	owned := map[string]*gameplanev1alpha1.GameServer{}
	for i := range children.Items {
		if metav1.IsControlledBy(&children.Items[i], &set) {
			owned[children.Items[i].Name] = &children.Items[i]
		}
	}
	spec := serverSetChildSpec(&set)
	hash, err := serverSetSpecHash(spec)
	if err != nil {
		return ctrl.Result{}, err
	}
	status := gameplanev1alpha1.GameServerSetStatus{ObservedGeneration: set.Generation}
	for i := range set.Spec.Replicas {
		name := fmt.Sprintf("%s-%d", set.Name, i)
		child, ok := owned[name]
		delete(owned, name)
		if !ok {
			taken, err := r.repositoryExists(ctx, set.Namespace, name)
			if err != nil {
				return ctrl.Result{}, err
			}
			if taken {
				ctrl.LoggerFrom(ctx).Info("skip set child, repository has the same name", "set", set.Name, "child", name)
				continue
			}
			if err := r.createChild(ctx, &set, name, spec, hash); err != nil {
				return ctrl.Result{}, err
			}
			status.Replicas++
			continue
		}
		if child.Annotations[serverSetHashAnnotation] != hash {
			if err := r.updateChild(ctx, child, spec, hash); err != nil {
				return ctrl.Result{}, err
			}
		}
		status.Replicas++
		if child.Status.Phase == gameplanev1alpha1.GameServerPhaseRunning {
			status.ReadyReplicas++
		}
	}
	for _, extra := range owned {
		if err := r.Delete(ctx, extra); client.IgnoreNotFound(err) != nil {
			return ctrl.Result{}, fmt.Errorf("delete set child %s: %w", extra.Name, err)
		}
	}
	if set.Status != status {
		set.Status = status
		if err := r.Status().Update(ctx, &set); err != nil {
			return ctrl.Result{}, fmt.Errorf("update set status: %w", err)
		}
	}
	return ctrl.Result{}, nil
}

func (r *GameServerSetReconciler) createChild(
	ctx context.Context, set *gameplanev1alpha1.GameServerSet, name string, spec *gameplanev1alpha1.GameServerSpec, hash string,
) error {
	child := &gameplanev1alpha1.GameServer{
		ObjectMeta: metav1.ObjectMeta{
			Name:        name,
			Namespace:   set.Namespace,
			Labels:      map[string]string{serverSetLabel: set.Name},
			Annotations: map[string]string{serverSetHashAnnotation: hash},
		},
		Spec: *spec.DeepCopy(),
	}
	for _, key := range serverSetInheritedAnnotations {
		if value := set.Annotations[key]; value != "" {
			child.Annotations[key] = value
		}
	}
	if err := controllerutil.SetControllerReference(set, child, r.Scheme); err != nil {
		return fmt.Errorf("own set child %s: %w", name, err)
	}
	if err := r.Create(ctx, child); client.IgnoreAlreadyExists(err) != nil {
		return fmt.Errorf("create set child %s: %w", name, err)
	}
	return nil
}

func (r *GameServerSetReconciler) repositoryExists(ctx context.Context, namespace, name string) (bool, error) {
	var repository gameplanev1alpha1.Repository
	err := r.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, &repository)
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("get repository %s: %w", name, err)
	}
	return true, nil
}

func (r *GameServerSetReconciler) updateChild(
	ctx context.Context, child *gameplanev1alpha1.GameServer, spec *gameplanev1alpha1.GameServerSpec, hash string,
) error {
	suspend := child.Spec.Suspend
	child.Spec = *spec.DeepCopy()
	child.Spec.Suspend = suspend
	if child.Annotations == nil {
		child.Annotations = map[string]string{}
	}
	child.Annotations[serverSetHashAnnotation] = hash
	if err := r.Update(ctx, child); err != nil {
		return fmt.Errorf("update set child %s: %w", child.Name, err)
	}
	return nil
}

func serverSetChildSpec(set *gameplanev1alpha1.GameServerSet) *gameplanev1alpha1.GameServerSpec {
	spec := set.Spec.Template.DeepCopy()
	spec.Networking.Address = ""
	for i := range spec.Networking.PortOverrides {
		spec.Networking.PortOverrides[i].NodePort = 0
	}
	if spec.Affinity == nil {
		spec.Affinity = &corev1.Affinity{}
	}
	if len(set.Spec.Nodes) > 0 {
		spec.Affinity.NodeAffinity = &corev1.NodeAffinity{
			RequiredDuringSchedulingIgnoredDuringExecution: &corev1.NodeSelector{
				NodeSelectorTerms: []corev1.NodeSelectorTerm{{
					MatchFields: []corev1.NodeSelectorRequirement{{
						Key:      "metadata.name",
						Operator: corev1.NodeSelectorOpIn,
						Values:   append([]string(nil), set.Spec.Nodes...),
					}},
				}},
			},
		}
	}
	if spec.Affinity.PodAntiAffinity == nil {
		spec.Affinity.PodAntiAffinity = &corev1.PodAntiAffinity{}
	}
	spec.Affinity.PodAntiAffinity.PreferredDuringSchedulingIgnoredDuringExecution = append(
		spec.Affinity.PodAntiAffinity.PreferredDuringSchedulingIgnoredDuringExecution,
		corev1.WeightedPodAffinityTerm{
			Weight: 100,
			PodAffinityTerm: corev1.PodAffinityTerm{
				LabelSelector: &metav1.LabelSelector{MatchLabels: map[string]string{serverSetLabel: set.Name}},
				TopologyKey:   corev1.LabelHostname,
			},
		},
	)
	return spec
}

func serverSetSpecHash(spec *gameplanev1alpha1.GameServerSpec) (string, error) {
	raw, err := json.Marshal(spec)
	if err != nil {
		return "", fmt.Errorf("hash set template: %w", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:8]), nil
}

func (r *GameServerSetReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&gameplanev1alpha1.GameServerSet{}).
		Owns(&gameplanev1alpha1.GameServer{}).
		Complete(r)
}
