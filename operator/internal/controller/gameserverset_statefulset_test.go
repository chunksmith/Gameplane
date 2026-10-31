package controller

import (
	"context"
	"slices"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

func statefulSetTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := testScheme(t)
	if err := networkingv1.AddToScheme(scheme); err != nil {
		t.Fatalf("networking scheme: %v", err)
	}
	if err := rbacv1.AddToScheme(scheme); err != nil {
		t.Fatalf("rbac scheme: %v", err)
	}
	return scheme
}

func statefulSetTestSet(replicas int32) *gameplanev1alpha1.GameServerSet {
	return &gameplanev1alpha1.GameServerSet{
		ObjectMeta: metav1.ObjectMeta{Name: "smp", Namespace: "games", UID: types.UID("set-uid")},
		Spec: gameplanev1alpha1.GameServerSetSpec{
			Replicas: replicas,
			Mode:     gameplanev1alpha1.GameServerSetModeStatefulSet,
		},
	}
}

func TestGameServerWorkloadNames(t *testing.T) {
	standalone := &gameplanev1alpha1.GameServer{ObjectMeta: metav1.ObjectMeta{Name: "lobby"}}
	if gamePodName(standalone) != "lobby-0" || dataClaimName(standalone) != "lobby-data" {
		t.Errorf("standalone names = %q %q", gamePodName(standalone), dataClaimName(standalone))
	}
	if selector := gamePodSelector(standalone); selector["app.kubernetes.io/instance"] != "lobby" {
		t.Errorf("standalone selector = %v", selector)
	}
	replica := &gameplanev1alpha1.GameServer{ObjectMeta: metav1.ObjectMeta{
		Name:   "smp-3",
		Labels: map[string]string{serverSetStatefulSetLabel: "smp"},
	}}
	if gamePodName(replica) != "smp-3" || dataClaimName(replica) != "data-smp-3" {
		t.Errorf("replica names = %q %q", gamePodName(replica), dataClaimName(replica))
	}
	selector := gamePodSelector(replica)
	if selector[statefulSetPodNameLabel] != "smp-3" || selector[serverSetStatefulSetLabel] != "smp" || selector["app.kubernetes.io/instance"] != "" {
		t.Errorf("replica selector = %v", selector)
	}
}

func TestApplyReplicaPodOverrides(t *testing.T) {
	grace := int32(600)
	carrier := &gameplanev1alpha1.GameServer{Spec: gameplanev1alpha1.GameServerSpec{StopGracePeriodSeconds: &grace}}
	spec := &corev1.PodSpec{
		Volumes: []corev1.Volume{{Name: "data"}, {Name: "agent-tls"}},
		Containers: []corev1.Container{
			{Name: gameContainerName, Env: []corev1.EnvVar{{Name: "GAMEPLANE_SERVER_NAME", Value: "keep"}}},
			{Name: agentContainerName, Env: []corev1.EnvVar{
				{Name: "GAMEPLANE_SERVER_NAME", Value: "smp"},
				{Name: "GAMEPLANE_SERVER_UID", Value: ""},
				{Name: "GAMEPLANE_TEMPLATE", Value: "paper"},
			}},
		},
	}
	applyReplicaPodOverrides(spec, carrier)
	if len(spec.Volumes) != 1 || spec.Volumes[0].Name != "agent-tls" {
		t.Errorf("volumes = %v, want the data volume left to the claim template", spec.Volumes)
	}
	if spec.TerminationGracePeriodSeconds == nil || *spec.TerminationGracePeriodSeconds != 600 {
		t.Errorf("termination grace = %v, want 600", spec.TerminationGracePeriodSeconds)
	}
	if spec.Containers[0].Env[0].Value != "keep" {
		t.Errorf("game env changed: %v", spec.Containers[0].Env)
	}
	if len(spec.InitContainers) != 1 || spec.InitContainers[0].Name != holdContainerName ||
		spec.InitContainers[0].Args[0] != "--mode=hold" || spec.InitContainers[0].Env[0].ValueFrom == nil {
		t.Errorf("init containers = %+v, want the hold gate first", spec.InitContainers)
	}
	agentEnv := spec.Containers[1].Env
	if len(agentEnv) != 2 || agentEnv[0].Name != "GAMEPLANE_TEMPLATE" {
		t.Fatalf("agent env = %v", agentEnv)
	}
	name := agentEnv[1]
	if name.Name != "GAMEPLANE_SERVER_NAME" || name.ValueFrom == nil || name.ValueFrom.FieldRef.FieldPath != "metadata.name" {
		t.Errorf("agent server name = %+v, want the pod name", name)
	}

	ephemeral := &gameplanev1alpha1.GameServer{Spec: gameplanev1alpha1.GameServerSpec{Storage: &gameplanev1alpha1.GameStorageSpec{Ephemeral: true}}}
	spec = &corev1.PodSpec{Volumes: []corev1.Volume{{Name: "data"}}}
	applyReplicaPodOverrides(spec, ephemeral)
	if len(spec.Volumes) != 1 {
		t.Errorf("ephemeral volumes = %v, want the emptyDir data volume kept", spec.Volumes)
	}
}

func TestReplicaAgentDNSNames(t *testing.T) {
	names := replicaAgentDNSNames(statefulSetTestSet(2), []string{"smp-0", "smp-1"})
	for _, want := range []string{"smp-agent", "smp-0-agent.games.svc.cluster.local", "smp-1-agent", "smp-1-agent.games.svc"} {
		if !slices.Contains(names, want) {
			t.Errorf("DNS names %v miss %q", names, want)
		}
	}
}

func TestStatefulSetChildStale(t *testing.T) {
	set := statefulSetTestSet(1)
	set.Annotations = map[string]string{"gameplane.local/owner-id": "7"}
	child := &gameplanev1alpha1.GameServer{ObjectMeta: metav1.ObjectMeta{
		Labels:      map[string]string{serverSetStatefulSetLabel: "smp"},
		Annotations: map[string]string{serverSetHashAnnotation: "h", "gameplane.local/owner-id": "7"},
	}}
	if statefulSetChildStale(set, child, "h") {
		t.Error("matching child reported stale")
	}
	child.Annotations["gameplane.local/owner-id"] = "9"
	if !statefulSetChildStale(set, child, "h") {
		t.Error("child with a foreign owner not reported stale")
	}
	child.Annotations["gameplane.local/owner-id"] = "7"
	child.Spec.Suspend = true
	if statefulSetChildStale(set, child, "h") {
		t.Error("held child reported stale: replica suspend belongs to the replica")
	}
}

func TestReconcileReplicaPorts(t *testing.T) {
	ctx := context.Background()
	set := statefulSetTestSet(3)
	set.Spec.ReplicaPorts = []gameplanev1alpha1.ReplicaPort{{Name: "voice", BasePort: 7200, ExternalIPs: []string{"203.0.113.10"}}}
	c := fake.NewClientBuilder().WithScheme(statefulSetTestScheme(t)).WithObjects(set).Build()
	r := &GameServerSetReconciler{Client: c, Scheme: c.Scheme(), Servers: &GameServerReconciler{}}
	if err := r.reconcileReplicaPorts(ctx, set); err != nil {
		t.Fatalf("reconcileReplicaPorts: %v", err)
	}
	var svc corev1.Service
	if err := c.Get(ctx, client.ObjectKey{Namespace: "games", Name: "smp-2-voice"}, &svc); err != nil {
		t.Fatalf("get smp-2-voice: %v", err)
	}
	port := svc.Spec.Ports[0]
	if port.Port != 7202 || port.TargetPort.IntVal != 7202 || port.Protocol != corev1.ProtocolUDP {
		t.Errorf("port = %+v, want UDP 7202", port)
	}
	if svc.Spec.Selector[statefulSetPodNameLabel] != "smp-2" || !slices.Equal(svc.Spec.ExternalIPs, []string{"203.0.113.10"}) {
		t.Errorf("service = %+v", svc.Spec)
	}

	set.Spec.Replicas = 2
	if err := r.reconcileReplicaPorts(ctx, set); err != nil {
		t.Fatalf("reconcileReplicaPorts after scale-down: %v", err)
	}
	if err := c.Get(ctx, client.ObjectKey{Namespace: "games", Name: "smp-2-voice"}, &svc); err == nil {
		t.Error("smp-2-voice kept after scale-down")
	}
}

func TestReconcileReplicaPortPolicy(t *testing.T) {
	ctx := context.Background()
	set := statefulSetTestSet(16)
	set.Spec.ReplicaPorts = []gameplanev1alpha1.ReplicaPort{{Name: "voice", BasePort: 7200}}
	c := fake.NewClientBuilder().WithScheme(statefulSetTestScheme(t)).WithObjects(set).Build()
	r := &GameServerSetReconciler{Client: c, Scheme: c.Scheme(), Servers: &GameServerReconciler{
		GameIngressPolicyEnabled: true, GameIngressFromCIDRs: []string{"0.0.0.0/0"},
	}}
	if err := r.reconcileReplicaPortPolicy(ctx, set); err != nil {
		t.Fatalf("reconcileReplicaPortPolicy: %v", err)
	}
	var np networkingv1.NetworkPolicy
	if err := c.Get(ctx, client.ObjectKey{Namespace: "games", Name: "smp-replica-ports"}, &np); err != nil {
		t.Fatalf("get policy: %v", err)
	}
	port := np.Spec.Ingress[0].Ports[0]
	if port.Port.IntVal != 7200 || port.EndPort == nil || *port.EndPort != 7215 || *port.Protocol != corev1.ProtocolUDP {
		t.Errorf("policy port = %+v, want UDP 7200-7215", port)
	}
}

func TestReconcilePlacementClaims(t *testing.T) {
	ctx := context.Background()
	set := statefulSetTestSet(2)
	set.Spec.Placement = []gameplanev1alpha1.ReplicaPlacement{{Ordinal: 1, Node: "node-b"}, {Ordinal: 5, Node: "node-c"}}
	carrier := serverSetCarrier(set, serverSetChildSpec(set))
	tmpl := &gameplanev1alpha1.GameTemplate{}
	c := fake.NewClientBuilder().WithScheme(statefulSetTestScheme(t)).WithObjects(set).Build()
	r := &GameServerSetReconciler{Client: c, Scheme: c.Scheme(), Servers: &GameServerReconciler{DefaultStorageClassName: "local-path"}}

	placed, err := r.reconcilePlacementClaims(ctx, set, carrier, tmpl)
	if err != nil || placed {
		t.Fatalf("first pass placed=%v err=%v, want unplaced while the claim binds", placed, err)
	}
	var pvc corev1.PersistentVolumeClaim
	if err := c.Get(ctx, client.ObjectKey{Namespace: "games", Name: "data-smp-1"}, &pvc); err != nil {
		t.Fatalf("get pinned claim: %v", err)
	}
	if pvc.Annotations[selectedNodeAnnotation] != "node-b" || *pvc.Spec.StorageClassName != "local-path" || len(pvc.OwnerReferences) != 0 {
		t.Errorf("pinned claim = %+v", pvc.ObjectMeta)
	}
	if err := c.Get(ctx, client.ObjectKey{Namespace: "games", Name: "data-smp-5"}, &pvc); err == nil {
		t.Error("claim created for an ordinal above replicas")
	}

	if err := c.Get(ctx, client.ObjectKey{Namespace: "games", Name: "data-smp-1"}, &pvc); err != nil {
		t.Fatal(err)
	}
	pvc.Status.Phase = corev1.ClaimBound
	if err := c.Status().Update(ctx, &pvc); err != nil {
		t.Fatalf("bind claim: %v", err)
	}
	if placed, err := r.reconcilePlacementClaims(ctx, set, carrier, tmpl); err != nil || !placed {
		t.Errorf("bound pass placed=%v err=%v, want placed", placed, err)
	}
}

func TestReconcileSetStatefulSetHoldsReplicasUntilPlaced(t *testing.T) {
	ctx := context.Background()
	set := statefulSetTestSet(4)
	set.Spec.MinReadySeconds = 10
	set.Spec.Template.PodLabels = map[string]string{"app": "smp", serverSetLabel: "hijack"}
	set.Spec.Template.ScratchVolumes = []gameplanev1alpha1.ScratchVolume{{Name: "tools", MountPath: "/opt/tools"}}
	set.Spec.Template.EnvFrom = []corev1.EnvFromSource{{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "global-env"}}}}
	set.Spec.Template.Lifecycle = &corev1.Lifecycle{PreStop: &corev1.LifecycleHandler{Exec: &corev1.ExecAction{Command: []string{"stop"}}}}
	carrier := serverSetCarrier(set, serverSetChildSpec(set))
	tmpl := &gameplanev1alpha1.GameTemplate{ObjectMeta: metav1.ObjectMeta{Name: "paper"}, Spec: gameplanev1alpha1.GameTemplateSpec{Image: "paper:1"}}
	c := fake.NewClientBuilder().WithScheme(statefulSetTestScheme(t)).WithObjects(set).Build()
	r := &GameServerSetReconciler{Client: c, Scheme: c.Scheme(), Servers: &GameServerReconciler{}}
	mc := &materializedConfig{}

	if err := r.reconcileSetStatefulSet(ctx, set, carrier, tmpl, nil, mc, false); err != nil {
		t.Fatalf("reconcileSetStatefulSet: %v", err)
	}
	var sts appsv1.StatefulSet
	if err := c.Get(ctx, client.ObjectKey{Namespace: "games", Name: "smp"}, &sts); err != nil {
		t.Fatalf("get StatefulSet: %v", err)
	}
	if *sts.Spec.Replicas != 0 {
		t.Errorf("replicas = %d, want 0 until pinned claims bind", *sts.Spec.Replicas)
	}
	if sts.Spec.PodManagementPolicy != appsv1.ParallelPodManagement || sts.Spec.MinReadySeconds != 10 ||
		sts.Spec.PersistentVolumeClaimRetentionPolicy.WhenScaled != appsv1.RetainPersistentVolumeClaimRetentionPolicyType ||
		len(sts.Spec.VolumeClaimTemplates) != 1 || sts.Spec.VolumeClaimTemplates[0].Name != "data" {
		t.Errorf("StatefulSet spec = %+v", sts.Spec)
	}
	if sts.Spec.Template.Labels[serverSetStatefulSetLabel] != "smp" || sts.Spec.Template.Spec.ServiceAccountName != "smp-agent" {
		t.Errorf("pod template = %+v", sts.Spec.Template.ObjectMeta)
	}
	if sts.Spec.Template.Labels["app"] != "smp" || sts.Spec.Template.Labels[serverSetLabel] != "smp" {
		t.Errorf("pod labels = %v, want app added and set label kept", sts.Spec.Template.Labels)
	}
	game := sts.Spec.Template.Spec.Containers[0]
	if len(game.EnvFrom) != 1 || game.Lifecycle == nil || game.Lifecycle.PreStop == nil {
		t.Errorf("game container envFrom/lifecycle = %+v / %+v", game.EnvFrom, game.Lifecycle)
	}
	if !slices.ContainsFunc(game.VolumeMounts, func(m corev1.VolumeMount) bool { return m.Name == "scratch-tools" && m.MountPath == "/opt/tools" }) ||
		!slices.ContainsFunc(sts.Spec.Template.Spec.Volumes, func(v corev1.Volume) bool { return v.Name == "scratch-tools" && v.EmptyDir != nil }) {
		t.Errorf("scratch volume missing: mounts %+v", game.VolumeMounts)
	}

	if err := r.reconcileSetStatefulSet(ctx, set, carrier, tmpl, nil, mc, true); err != nil {
		t.Fatalf("reconcileSetStatefulSet placed: %v", err)
	}
	if err := c.Get(ctx, client.ObjectKey{Namespace: "games", Name: "smp"}, &sts); err != nil {
		t.Fatal(err)
	}
	if *sts.Spec.Replicas != 4 {
		t.Errorf("replicas = %d, want 4 once placed", *sts.Spec.Replicas)
	}
}

func TestReconcileSetAgentRBACWithoutReplicas(t *testing.T) {
	ctx := context.Background()
	set := statefulSetTestSet(0)
	c := fake.NewClientBuilder().WithScheme(statefulSetTestScheme(t)).WithObjects(set).Build()
	r := &GameServerSetReconciler{Client: c, Scheme: c.Scheme(), Servers: &GameServerReconciler{}}
	if err := r.reconcileSetAgentRBAC(ctx, set, nil); err != nil {
		t.Fatalf("reconcileSetAgentRBAC: %v", err)
	}
	var role rbacv1.Role
	if err := c.Get(ctx, client.ObjectKey{Namespace: "games", Name: "smp-agent-heartbeat"}, &role); err != nil {
		t.Fatal(err)
	}
	if len(role.Rules) != 0 {
		t.Errorf("rules = %+v, want none: empty resourceNames would grant every GameServer", role.Rules)
	}
}

func rolloutTestPod(name, revision string, ready bool) *corev1.Pod {
	set := statefulSetTestSet(0)
	labels := statefulSetSelector(set)
	labels[appsv1.ControllerRevisionHashLabelKey] = revision
	status := corev1.ConditionFalse
	if ready {
		status = corev1.ConditionTrue
	}
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "games", UID: types.UID(name), Labels: labels},
		Status: corev1.PodStatus{Conditions: []corev1.PodCondition{{
			Type: corev1.PodReady, Status: status, LastTransitionTime: metav1.NewTime(time.Now().Add(-time.Hour)),
		}}},
	}
}

func TestRolloutStatefulSetSkipsHeldReplicas(t *testing.T) {
	ctx := context.Background()
	set := statefulSetTestSet(3)
	replicas := int32(3)
	sts := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: "smp", Namespace: "games", Generation: 2},
		Spec:       appsv1.StatefulSetSpec{Replicas: &replicas},
		Status:     appsv1.StatefulSetStatus{ObservedGeneration: 2, UpdateRevision: "new"},
	}
	run := func(pods ...*corev1.Pod) (client.Client, int32) {
		objects := []client.Object{set, sts}
		for _, pod := range pods {
			objects = append(objects, pod)
		}
		c := fake.NewClientBuilder().WithScheme(statefulSetTestScheme(t)).WithObjects(objects...).Build()
		r := &GameServerSetReconciler{Client: c, Scheme: c.Scheme()}
		updated, _, err := r.rolloutStatefulSet(ctx, set, map[string]bool{"smp-1": true})
		if err != nil {
			t.Fatalf("rolloutStatefulSet: %v", err)
		}
		return c, updated
	}
	exists := func(c client.Client, name string) bool {
		return c.Get(ctx, client.ObjectKey{Namespace: "games", Name: name}, &corev1.Pod{}) == nil
	}

	c, updated := run(rolloutTestPod("smp-0", "old", true), rolloutTestPod("smp-1", "old", false), rolloutTestPod("smp-2", "new", true))
	if updated != 1 {
		t.Errorf("updated = %d, want 1", updated)
	}
	if exists(c, "smp-1") || exists(c, "smp-0") || !exists(c, "smp-2") {
		t.Error("want the held pod and the next outdated pod rolled, the updated pod kept")
	}

	c, _ = run(rolloutTestPod("smp-0", "old", true), rolloutTestPod("smp-1", "new", false), rolloutTestPod("smp-2", "new", false))
	if !exists(c, "smp-0") {
		t.Error("rolled smp-0 while the updated smp-2 is not ready")
	}

	c, updated = run(rolloutTestPod("smp-0", "old", true), rolloutTestPod("smp-1", "new", false), rolloutTestPod("smp-2", "new", true))
	if updated != 2 || exists(c, "smp-0") {
		t.Errorf("updated = %d, smp-0 kept = %v; want a held updated pod counted and smp-0 rolled", updated, exists(c, "smp-0"))
	}
}

func TestReplicaReleased(t *testing.T) {
	pod := &corev1.Pod{Spec: corev1.PodSpec{InitContainers: []corev1.Container{{Name: holdContainerName}}}}
	if replicaReleased(pod) {
		t.Error("pod without gate status reported released")
	}
	pod.Status.InitContainerStatuses = []corev1.ContainerStatus{{Name: holdContainerName, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}}
	if replicaReleased(pod) {
		t.Error("pod waiting in the gate reported released")
	}
	pod.Status.InitContainerStatuses[0].State = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 0}}
	if !replicaReleased(pod) {
		t.Error("pod past the gate reported held")
	}
	if !replicaReleased(&corev1.Pod{}) {
		t.Error("pod without a gate reported held")
	}
}
