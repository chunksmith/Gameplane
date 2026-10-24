package controller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

const filesPodHashAnnotation = "gameplane.local/files-pod-hash"

func filesPodName(gs *gameplanev1alpha1.GameServer) string {
	return gs.Name + "-files"
}

func wantFilesPod(gs *gameplanev1alpha1.GameServer, idle idleState, replicas int32) bool {
	return !isEphemeral(gs) && replicas == 0 && (gs.Spec.Suspend || idle == idleAsleep) &&
		gs.Annotations[restoreGuardAnnotation] == "" && gs.Annotations[wipeGuardAnnotation] == "" && !pendingWipe(gs)
}

func (r *GameServerReconciler) reconcileFilesPod(
	ctx context.Context, gs *gameplanev1alpha1.GameServer, tmpl *gameplanev1alpha1.GameTemplate,
	ver *gameplanev1alpha1.GameVersion, want bool,
) error {
	if want {
		var ss appsv1.StatefulSet
		err := r.Get(ctx, client.ObjectKeyFromObject(gs), &ss)
		if err != nil && !apierrors.IsNotFound(err) {
			return fmt.Errorf("get StatefulSet: %w", err)
		}
		want = err != nil || ss.Status.Replicas == 0
	}
	desired, err := r.buildFilesPod(gs, tmpl, ver)
	if err != nil {
		return err
	}
	var pod corev1.Pod
	err = r.Get(ctx, types.NamespacedName{Namespace: gs.Namespace, Name: desired.Name}, &pod)
	if apierrors.IsNotFound(err) {
		if !want {
			return nil
		}
		return client.IgnoreAlreadyExists(r.Create(ctx, desired))
	}
	if err != nil {
		return fmt.Errorf("get files pod: %w", err)
	}
	if !metav1.IsControlledBy(&pod, gs) {
		return fmt.Errorf("pod %s is not controlled by the GameServer", pod.Name)
	}
	if !pod.DeletionTimestamp.IsZero() || (want && pod.Annotations[filesPodHashAnnotation] == desired.Annotations[filesPodHashAnnotation]) {
		return nil
	}
	uid := pod.UID
	if err := r.Delete(ctx, &pod, client.Preconditions{UID: &uid}); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete files pod: %w", err)
	}
	return nil
}

func (r *GameServerReconciler) buildFilesPod(
	gs *gameplanev1alpha1.GameServer, tmpl *gameplanev1alpha1.GameTemplate, ver *gameplanev1alpha1.GameVersion,
) (*corev1.Pod, error) {
	agent := buildAgentContainer(gs, tmpl, ver, r.AgentImage, r.AgentLogLevel, r.AgentImagePullPolicy)
	agent.Env = append(agent.Env, corev1.EnvVar{Name: "GAMEPLANE_HEARTBEAT", Value: "false"})
	volumes := []corev1.Volume{
		{
			Name: "data",
			VolumeSource: corev1.VolumeSource{
				PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: gs.Name + "-data"},
			},
		},
		agentTLSVolume(gs),
	}
	if v := rconPasswordVolume(gs, tmpl); v != nil {
		volumes = append(volumes, *v)
	}
	if v := modVolume(gs, tmpl, ver); v != nil {
		volumes = append(volumes, *v)
	}
	volumes = append(volumes, modCredsVolumes(resolveModCreds(tmpl))...)
	grace := int64(5)
	spec := corev1.PodSpec{
		Containers:                    []corev1.Container{agent},
		Volumes:                       volumes,
		ImagePullSecrets:              r.ImagePullSecrets,
		NodeSelector:                  gs.Spec.NodeSelector,
		Tolerations:                   gs.Spec.Tolerations,
		Affinity:                      gs.Spec.Affinity,
		SecurityContext:               gamePodSecurityContext(tmpl),
		ServiceAccountName:            agentServiceAccountName(gs),
		TerminationGracePeriodSeconds: &grace,
	}
	if gs.Spec.ServiceAccountName != "" {
		spec.ServiceAccountName = gs.Spec.ServiceAccountName
	}
	raw, err := json.Marshal(spec)
	if err != nil {
		return nil, fmt.Errorf("marshal files pod spec: %w", err)
	}
	sum := sha256.Sum256(raw)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      filesPodName(gs),
			Namespace: gs.Namespace,
			Labels: map[string]string{
				"app.kubernetes.io/name":     "gameplane-game",
				"app.kubernetes.io/instance": gs.Name,
			},
			Annotations: map[string]string{filesPodHashAnnotation: hex.EncodeToString(sum[:])},
		},
		Spec: spec,
	}
	if err := controllerutil.SetControllerReference(gs, pod, r.Scheme); err != nil {
		return nil, fmt.Errorf("set files pod owner: %w", err)
	}
	return pod, nil
}

func agentTLSVolume(gs *gameplanev1alpha1.GameServer) corev1.Volume {
	return corev1.Volume{
		Name: "agent-tls",
		VolumeSource: corev1.VolumeSource{
			Secret: &corev1.SecretVolumeSource{SecretName: agentTLSSecretName(gs)},
		},
	}
}

func rconPasswordVolume(gs *gameplanev1alpha1.GameServer, tmpl *gameplanev1alpha1.GameTemplate) *corev1.Volume {
	rc := resolveRCON(gs, tmpl)
	if !rc.enabled || rc.passwordFile != "" || rc.secretName == "" {
		return nil
	}
	return &corev1.Volume{
		Name: "rcon-password",
		VolumeSource: corev1.VolumeSource{
			Secret: &corev1.SecretVolumeSource{
				SecretName: rc.secretName,
				Items:      []corev1.KeyToPath{{Key: rc.secretKey, Path: "password"}},
			},
		},
	}
}
