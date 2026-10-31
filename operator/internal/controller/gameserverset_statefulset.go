package controller

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

const (
	serverSetPortLabel     = "gameplane.local/server-set-port"
	selectedNodeAnnotation = "volume.kubernetes.io/selected-node"
	agentContainerName     = "agent"
	placementRequeue       = 5 * time.Second
)

func (r *GameServerSetReconciler) reconcileStatefulSetMode(
	ctx context.Context, set *gameplanev1alpha1.GameServerSet, owned map[string]*gameplanev1alpha1.GameServer,
) (ctrl.Result, error) {
	if r.Servers == nil {
		return ctrl.Result{}, errors.New("StatefulSet server groups need the GameServer reconciler")
	}
	spec := serverSetChildSpec(set)
	hash, err := serverSetSpecHash(spec)
	if err != nil {
		return ctrl.Result{}, err
	}
	var tmpl gameplanev1alpha1.GameTemplate
	if err := r.Get(ctx, types.NamespacedName{Name: spec.TemplateRef.Name}, &tmpl); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
		}
		return ctrl.Result{}, err
	}
	carrier := serverSetCarrier(set, spec)
	mc, err := materializeConfig(carrier, &tmpl)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("materialize set config: %w", err)
	}
	ver, err := resolveVersion(carrier, &tmpl)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("resolve set version: %w", err)
	}
	if len(extraVolumes(carrier, &tmpl)) > 0 || modVolume(carrier, &tmpl, ver) != nil {
		return ctrl.Result{}, errors.New("StatefulSet server groups do not support extra or mod volumes")
	}
	if err := r.Servers.validateServerEnvSources(ctx, carrier); err != nil {
		return ctrl.Result{}, err
	}

	names := make([]string, 0, set.Spec.Replicas)
	for i := range set.Spec.Replicas {
		names = append(names, fmt.Sprintf("%s-%d", set.Name, i))
	}
	if err := r.reconcileSetSecrets(ctx, set, carrier, &tmpl, mc); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileSetAgentRBAC(ctx, set, names); err != nil {
		return ctrl.Result{}, err
	}
	if err := ensureAgentTLSNames(ctx, r.Client, r.Scheme, r.Servers.AgentCASecretName, r.Servers.AgentCASecretNamespace,
		set, set.Name, replicaAgentDNSNames(set, names)); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileHeadlessService(ctx, set, carrier, &tmpl); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileReplicaPorts(ctx, set); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileReplicaPortPolicy(ctx, set); err != nil {
		return ctrl.Result{}, err
	}
	placed, err := r.reconcilePlacementClaims(ctx, set, carrier, &tmpl)
	if err != nil {
		return ctrl.Result{}, err
	}
	if err := r.reconcileSetStatefulSet(ctx, set, carrier, &tmpl, ver, mc, placed); err != nil {
		return ctrl.Result{}, err
	}

	status := gameplanev1alpha1.GameServerSetStatus{ObservedGeneration: set.Generation}
	for _, name := range names {
		child, ok := owned[name]
		delete(owned, name)
		if !ok {
			taken, err := r.repositoryExists(ctx, set.Namespace, name)
			if err != nil {
				return ctrl.Result{}, err
			}
			if taken {
				continue
			}
			if err := r.createChild(ctx, set, name, statefulSetChildSpec(set, spec), hash); err != nil {
				return ctrl.Result{}, err
			}
			status.Replicas++
			continue
		}
		if statefulSetChildStale(set, child, hash) {
			if err := r.updateStatefulSetChild(ctx, set, child, statefulSetChildSpec(set, spec), hash); err != nil {
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
		if err := r.Status().Update(ctx, set); err != nil {
			return ctrl.Result{}, fmt.Errorf("update set status: %w", err)
		}
	}
	if !placed {
		return ctrl.Result{RequeueAfter: placementRequeue}, nil
	}
	return ctrl.Result{}, nil
}

func serverSetCarrier(set *gameplanev1alpha1.GameServerSet, spec *gameplanev1alpha1.GameServerSpec) *gameplanev1alpha1.GameServer {
	return &gameplanev1alpha1.GameServer{
		ObjectMeta: metav1.ObjectMeta{
			Name:      set.Name,
			Namespace: set.Namespace,
			Labels:    map[string]string{serverSetLabel: set.Name},
		},
		Spec: *spec.DeepCopy(),
	}
}

func statefulSetChildSpec(set *gameplanev1alpha1.GameServerSet, spec *gameplanev1alpha1.GameServerSpec) *gameplanev1alpha1.GameServerSpec {
	child := spec.DeepCopy()
	child.Suspend = set.Spec.Template.Suspend
	return child
}

func statefulSetChildStale(set *gameplanev1alpha1.GameServerSet, child *gameplanev1alpha1.GameServer, hash string) bool {
	if child.Annotations[serverSetHashAnnotation] != hash || child.Labels[serverSetStatefulSetLabel] != set.Name ||
		child.Spec.Suspend != set.Spec.Template.Suspend {
		return true
	}
	for _, key := range serverSetInheritedAnnotations {
		if child.Annotations[key] != set.Annotations[key] {
			return true
		}
	}
	return false
}

func (r *GameServerSetReconciler) updateStatefulSetChild(
	ctx context.Context, set *gameplanev1alpha1.GameServerSet, child *gameplanev1alpha1.GameServer,
	spec *gameplanev1alpha1.GameServerSpec, hash string,
) error {
	child.Spec = *spec
	if child.Labels == nil {
		child.Labels = map[string]string{}
	}
	child.Labels[serverSetLabel] = set.Name
	child.Labels[serverSetStatefulSetLabel] = set.Name
	if child.Annotations == nil {
		child.Annotations = map[string]string{}
	}
	child.Annotations[serverSetHashAnnotation] = hash
	for _, key := range serverSetInheritedAnnotations {
		if value := set.Annotations[key]; value != "" {
			child.Annotations[key] = value
		} else {
			delete(child.Annotations, key)
		}
	}
	if err := r.Update(ctx, child); err != nil {
		return fmt.Errorf("update set child %s: %w", child.Name, err)
	}
	return nil
}

func statefulSetSelector(set *gameplanev1alpha1.GameServerSet) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":  "gameplane-game",
		serverSetStatefulSetLabel: set.Name,
	}
}

func replicaSelector(set *gameplanev1alpha1.GameServerSet, name string) map[string]string {
	selector := statefulSetSelector(set)
	selector[statefulSetPodNameLabel] = name
	return selector
}

func replicaAgentDNSNames(set *gameplanev1alpha1.GameServerSet, names []string) []string {
	dnsNames := []string{set.Name + "-agent"}
	for _, name := range names {
		service := name + "-agent"
		dnsNames = append(dnsNames,
			service,
			fmt.Sprintf("%s.%s", service, set.Namespace),
			fmt.Sprintf("%s.%s.svc", service, set.Namespace),
			fmt.Sprintf("%s.%s.svc.cluster.local", service, set.Namespace),
		)
	}
	return dnsNames
}

func (r *GameServerSetReconciler) reconcileSetSecrets(
	ctx context.Context, set *gameplanev1alpha1.GameServerSet, carrier *gameplanev1alpha1.GameServer,
	tmpl *gameplanev1alpha1.GameTemplate, mc *materializedConfig,
) error {
	if err := r.upsertSetSecret(ctx, set, configSecretName(carrier), mc.secretData); err != nil {
		return err
	}
	files := make(map[string][]byte, len(mc.files))
	for _, file := range mc.files {
		files[file.key] = file.content
	}
	if err := r.upsertSetSecret(ctx, set, filesSecretName(carrier), files); err != nil {
		return err
	}
	rcon := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: rconSecretName(carrier), Namespace: set.Namespace}}
	if rc := resolveRCON(carrier, tmpl); !rc.enabled || rc.secretName != rcon.Name {
		return r.deleteSetOwned(ctx, set, rcon)
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, rcon, func() error {
		rcon.Type = corev1.SecretTypeOpaque
		if len(rcon.Data["password"]) == 0 {
			password, err := generatePassword()
			if err != nil {
				return err
			}
			rcon.Data = map[string][]byte{"password": []byte(password)}
		}
		return controllerutil.SetControllerReference(set, rcon, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("reconcile set rcon Secret %s: %w", rcon.Name, err)
	}
	return nil
}

func (r *GameServerSetReconciler) upsertSetSecret(
	ctx context.Context, set *gameplanev1alpha1.GameServerSet, name string, data map[string][]byte,
) error {
	sec := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: set.Namespace}}
	if len(data) == 0 {
		return r.deleteSetOwned(ctx, set, sec)
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, sec, func() error {
		sec.Type = corev1.SecretTypeOpaque
		sec.Data = data
		return controllerutil.SetControllerReference(set, sec, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("reconcile set Secret %s: %w", name, err)
	}
	return nil
}

func (r *GameServerSetReconciler) deleteSetOwned(ctx context.Context, set *gameplanev1alpha1.GameServerSet, obj client.Object) error {
	if err := r.Get(ctx, client.ObjectKeyFromObject(obj), obj); err != nil {
		return client.IgnoreNotFound(err)
	}
	if !metav1.IsControlledBy(obj, set) {
		return nil
	}
	uid := obj.GetUID()
	return client.IgnoreNotFound(r.Delete(ctx, obj, client.Preconditions{UID: &uid}))
}

func (r *GameServerSetReconciler) reconcileSetAgentRBAC(ctx context.Context, set *gameplanev1alpha1.GameServerSet, names []string) error {
	name := set.Name + "-agent"
	sa := &corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: set.Namespace}}
	if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, sa, func() error {
		return controllerutil.SetControllerReference(set, sa, r.Scheme)
	}); err != nil {
		return fmt.Errorf("upsert set agent ServiceAccount %s: %w", name, err)
	}
	role := &rbacv1.Role{ObjectMeta: metav1.ObjectMeta{Name: name + "-heartbeat", Namespace: set.Namespace}}
	if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, role, func() error {
		role.Rules = nil
		if len(names) > 0 {
			role.Rules = []rbacv1.PolicyRule{{
				APIGroups:     []string{"gameplane.local"},
				Resources:     []string{"gameservers/status"},
				ResourceNames: slices.Clone(names),
				Verbs:         []string{"get", "patch"},
			}}
		}
		return controllerutil.SetControllerReference(set, role, r.Scheme)
	}); err != nil {
		return fmt.Errorf("upsert set agent heartbeat Role %s: %w", role.Name, err)
	}
	binding := &rbacv1.RoleBinding{ObjectMeta: metav1.ObjectMeta{Name: role.Name, Namespace: set.Namespace}}
	if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, binding, func() error {
		binding.RoleRef = rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "Role", Name: role.Name}
		binding.Subjects = []rbacv1.Subject{{Kind: rbacv1.ServiceAccountKind, Name: name, Namespace: set.Namespace}}
		return controllerutil.SetControllerReference(set, binding, r.Scheme)
	}); err != nil {
		return fmt.Errorf("upsert set agent heartbeat RoleBinding %s: %w", binding.Name, err)
	}
	return nil
}

func (r *GameServerSetReconciler) reconcileHeadlessService(
	ctx context.Context, set *gameplanev1alpha1.GameServerSet, carrier *gameplanev1alpha1.GameServer,
	tmpl *gameplanev1alpha1.GameTemplate,
) error {
	svc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: set.Name, Namespace: set.Namespace}}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, svc, func() error {
		svc.Spec.ClusterIP = corev1.ClusterIPNone
		svc.Spec.Selector = statefulSetSelector(set)
		svc.Spec.Ports = svcPortsFromTemplate(tmpl, carrier)
		return controllerutil.SetControllerReference(set, svc, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("reconcile set headless Service: %w", err)
	}
	return nil
}

func replicaPortServiceName(set *gameplanev1alpha1.GameServerSet, ordinal int32, port string) string {
	return fmt.Sprintf("%s-%d-%s", set.Name, ordinal, port)
}

func (r *GameServerSetReconciler) reconcileReplicaPorts(ctx context.Context, set *gameplanev1alpha1.GameServerSet) error {
	want := map[string]bool{}
	for _, port := range set.Spec.ReplicaPorts {
		protocol := port.Protocol
		if protocol == "" {
			protocol = corev1.ProtocolUDP
		}
		for i := range set.Spec.Replicas {
			number := port.BasePort + i
			svc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: replicaPortServiceName(set, i, port.Name), Namespace: set.Namespace}}
			want[svc.Name] = true
			_, err := controllerutil.CreateOrUpdate(ctx, r.Client, svc, func() error {
				if svc.Labels == nil {
					svc.Labels = map[string]string{}
				}
				svc.Labels[serverSetPortLabel] = set.Name
				svc.Spec.Type = corev1.ServiceTypeClusterIP
				svc.Spec.ExternalIPs = slices.Clone(port.ExternalIPs)
				svc.Spec.Selector = replicaSelector(set, fmt.Sprintf("%s-%d", set.Name, i))
				svc.Spec.Ports = []corev1.ServicePort{{
					Name:       port.Name,
					Protocol:   protocol,
					Port:       number,
					TargetPort: intstr.FromInt32(number),
				}}
				return controllerutil.SetControllerReference(set, svc, r.Scheme)
			})
			if err != nil {
				return fmt.Errorf("reconcile replica port Service %s: %w", svc.Name, err)
			}
		}
	}
	var services corev1.ServiceList
	if err := r.List(ctx, &services, client.InNamespace(set.Namespace), client.MatchingLabels{serverSetPortLabel: set.Name}); err != nil {
		return fmt.Errorf("list replica port Services: %w", err)
	}
	for i := range services.Items {
		svc := &services.Items[i]
		if want[svc.Name] || !metav1.IsControlledBy(svc, set) {
			continue
		}
		if err := r.Delete(ctx, svc); client.IgnoreNotFound(err) != nil {
			return fmt.Errorf("delete replica port Service %s: %w", svc.Name, err)
		}
	}
	return nil
}

func (r *GameServerSetReconciler) reconcileReplicaPortPolicy(ctx context.Context, set *gameplanev1alpha1.GameServerSet) error {
	np := &networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: set.Name + "-replica-ports", Namespace: set.Namespace}}
	if !r.Servers.GameIngressPolicyEnabled || len(set.Spec.ReplicaPorts) == 0 || set.Spec.Replicas == 0 {
		return r.deleteSetOwned(ctx, set, np)
	}
	from := make([]networkingv1.NetworkPolicyPeer, 0, len(r.Servers.GameIngressFromCIDRs))
	for _, cidr := range r.Servers.GameIngressFromCIDRs {
		from = append(from, networkingv1.NetworkPolicyPeer{IPBlock: &networkingv1.IPBlock{CIDR: cidr}})
	}
	ports := make([]networkingv1.NetworkPolicyPort, 0, len(set.Spec.ReplicaPorts))
	for _, port := range set.Spec.ReplicaPorts {
		protocol := port.Protocol
		if protocol == "" {
			protocol = corev1.ProtocolUDP
		}
		start := intstr.FromInt32(port.BasePort)
		end := port.BasePort + set.Spec.Replicas - 1
		ports = append(ports, networkingv1.NetworkPolicyPort{Protocol: &protocol, Port: &start, EndPort: &end})
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, np, func() error {
		np.Spec.PodSelector = metav1.LabelSelector{MatchLabels: statefulSetSelector(set)}
		np.Spec.PolicyTypes = []networkingv1.PolicyType{networkingv1.PolicyTypeIngress}
		np.Spec.Ingress = []networkingv1.NetworkPolicyIngressRule{{From: from, Ports: ports}}
		return controllerutil.SetControllerReference(set, np, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("reconcile replica port NetworkPolicy: %w", err)
	}
	return nil
}

func (r *GameServerSetReconciler) dataClaimTemplate(
	carrier *gameplanev1alpha1.GameServer, tmpl *gameplanev1alpha1.GameTemplate,
) (resource.Quantity, *string) {
	size := storageSize(carrier, tmpl)
	switch {
	case carrier.Spec.Storage != nil && carrier.Spec.Storage.StorageClassName != nil:
		return size, carrier.Spec.Storage.StorageClassName
	case tmpl.Spec.Storage.StorageClassName != nil:
		return size, tmpl.Spec.Storage.StorageClassName
	case r.Servers.DefaultStorageClassName != "":
		name := r.Servers.DefaultStorageClassName
		return size, &name
	}
	return size, nil
}

func (r *GameServerSetReconciler) reconcilePlacementClaims(
	ctx context.Context, set *gameplanev1alpha1.GameServerSet, carrier *gameplanev1alpha1.GameServer,
	tmpl *gameplanev1alpha1.GameTemplate,
) (bool, error) {
	if isEphemeral(carrier) {
		return true, nil
	}
	size, className := r.dataClaimTemplate(carrier, tmpl)
	placed := true
	for _, pin := range set.Spec.Placement {
		if pin.Ordinal >= set.Spec.Replicas {
			continue
		}
		pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("data-%s-%d", set.Name, pin.Ordinal),
			Namespace: set.Namespace,
		}}
		err := r.Get(ctx, client.ObjectKeyFromObject(pvc), pvc)
		if apierrors.IsNotFound(err) {
			pvc.Labels = statefulSetSelector(set)
			pvc.Annotations = map[string]string{selectedNodeAnnotation: pin.Node}
			pvc.Spec.AccessModes = []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce}
			pvc.Spec.Resources.Requests = corev1.ResourceList{corev1.ResourceStorage: size}
			pvc.Spec.StorageClassName = className
			if err := r.Create(ctx, pvc); err != nil {
				return false, fmt.Errorf("create pinned PVC %s: %w", pvc.Name, err)
			}
			placed = false
			continue
		}
		if err != nil {
			return false, fmt.Errorf("get pinned PVC %s: %w", pvc.Name, err)
		}
		if pvc.Status.Phase != corev1.ClaimBound {
			placed = false
		}
	}
	return placed, nil
}

func (r *GameServerSetReconciler) reconcileSetStatefulSet(
	ctx context.Context, set *gameplanev1alpha1.GameServerSet, carrier *gameplanev1alpha1.GameServer,
	tmpl *gameplanev1alpha1.GameTemplate, ver *gameplanev1alpha1.GameVersion, mc *materializedConfig, placed bool,
) error {
	sts := &appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: set.Name, Namespace: set.Namespace}}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, sts, func() error {
		replicas := set.Spec.Replicas
		if set.Spec.Template.Suspend {
			replicas = 0
		}
		if !placed {
			current := int32(0)
			if sts.Spec.Replicas != nil {
				current = *sts.Spec.Replicas
			}
			replicas = min(replicas, current)
		}
		if sts.CreationTimestamp.IsZero() {
			sts.Spec.Selector = &metav1.LabelSelector{MatchLabels: statefulSetSelector(set)}
			sts.Spec.PodManagementPolicy = appsv1.ParallelPodManagement
			if !isEphemeral(carrier) {
				size, className := r.dataClaimTemplate(carrier, tmpl)
				sts.Spec.VolumeClaimTemplates = []corev1.PersistentVolumeClaim{{
					ObjectMeta: metav1.ObjectMeta{Name: "data"},
					Spec: corev1.PersistentVolumeClaimSpec{
						AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
						Resources:        corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: size}},
						StorageClassName: className,
					},
				}}
			}
		}
		sts.Spec.Replicas = &replicas
		sts.Spec.ServiceName = set.Name
		sts.Spec.MinReadySeconds = set.Spec.MinReadySeconds
		if sts.Spec.UpdateStrategy.Type != appsv1.RollingUpdateStatefulSetStrategyType {
			sts.Spec.UpdateStrategy = appsv1.StatefulSetUpdateStrategy{Type: appsv1.RollingUpdateStatefulSetStrategyType}
		}
		sts.Spec.PersistentVolumeClaimRetentionPolicy = &appsv1.StatefulSetPersistentVolumeClaimRetentionPolicy{
			WhenDeleted: appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
			WhenScaled:  appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
		}
		labels := statefulSetSelector(set)
		labels["app.kubernetes.io/instance"] = set.Name
		labels["gameplane.local/template"] = tmpl.Name
		labels[serverSetLabel] = set.Name
		sts.Spec.Template.Labels = labels
		r.Servers.applyGamePodTemplate(&sts.Spec.Template, carrier, tmpl, ver, mc, resolveImage(carrier, tmpl, ver))
		applyReplicaPodOverrides(&sts.Spec.Template.Spec, carrier)
		return controllerutil.SetControllerReference(set, sts, r.Scheme)
	})
	if err != nil {
		return fmt.Errorf("reconcile set StatefulSet: %w", err)
	}
	return nil
}

func applyReplicaPodOverrides(spec *corev1.PodSpec, carrier *gameplanev1alpha1.GameServer) {
	if !isEphemeral(carrier) {
		spec.Volumes = slices.DeleteFunc(spec.Volumes, func(volume corev1.Volume) bool { return volume.Name == "data" })
	}
	if carrier.Spec.StopGracePeriodSeconds != nil {
		grace := int64(*carrier.Spec.StopGracePeriodSeconds)
		spec.TerminationGracePeriodSeconds = &grace
	}
	for i := range spec.Containers {
		if spec.Containers[i].Name != agentContainerName {
			continue
		}
		env := slices.DeleteFunc(slices.Clone(spec.Containers[i].Env), func(variable corev1.EnvVar) bool {
			return variable.Name == "GAMEPLANE_SERVER_NAME" || variable.Name == "GAMEPLANE_SERVER_UID"
		})
		spec.Containers[i].Env = append(env, corev1.EnvVar{
			Name:      "GAMEPLANE_SERVER_NAME",
			ValueFrom: &corev1.EnvVarSource{FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.name"}},
		})
	}
}
