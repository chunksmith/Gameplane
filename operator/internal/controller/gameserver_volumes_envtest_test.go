//go:build envtest

package controller

import (
	"context"
	"slices"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
)

func TestCRDValidation_GameServerVolumesReservedNames(t *testing.T) {
	ns := newNamespace(t)
	for _, name := range []string{"data", "agent-tls", "captures", "config-files", "rcon-password", "scratch-tools", "extra-saves", "mods-paper", "mod-creds-modrinth"} {
		gs := validGameServer(ns, "v-reserved-volume")
		gs.Spec.Volumes = []corev1.Volume{{Name: name, VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}}}
		if err := k8sClient.Create(context.Background(), gs); !apierrors.IsInvalid(err) {
			t.Fatalf("volume %q: expected Invalid, got %v", name, err)
		}
	}

	gs := validGameServer(ns, "v-free-volume")
	gs.Spec.Volumes = []corev1.Volume{{Name: "tls", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: "geyser-tls"}}}}
	if err := k8sClient.Create(context.Background(), gs); err != nil {
		t.Fatalf("free volume name rejected: %v", err)
	}
}

func TestGameServer_VolumesMountedOnGameAndSidecar(t *testing.T) {
	ns := newNamespace(t)
	startMgr(t, ns, withGameServerReconciler(t, ns))

	tmpl := buildGameTemplate(uniqueName("minecraft"))
	if err := k8sClient.Create(context.Background(), tmpl); err != nil {
		t.Fatalf("create template: %v", err)
	}
	deleteCleanup(t, tmpl)

	always := corev1.ContainerRestartPolicyAlways
	gs := buildGameServer(ns, "vol", tmpl.Name)
	gs.Spec.Volumes = []corev1.Volume{
		{Name: "mux", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: "signaling-mux"}}}},
		{Name: "tls", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: "geyser-tls"}}},
	}
	gs.Spec.VolumeMounts = []corev1.VolumeMount{{Name: "tls", MountPath: "/certs", ReadOnly: true}}
	gs.Spec.InitContainers = []corev1.Container{{
		Name:          "signaling-mux",
		Image:         "nginx:1.27-alpine",
		RestartPolicy: &always,
		VolumeMounts: []corev1.VolumeMount{
			{Name: "mux", MountPath: "/etc/nginx/nginx.conf", SubPath: "nginx.conf"},
			{Name: "tls", MountPath: "/certs", ReadOnly: true},
		},
	}}
	if err := k8sClient.Create(context.Background(), gs); err != nil {
		t.Fatalf("create gameserver: %v", err)
	}

	eventually(t, func() (bool, string) {
		var ss appsv1.StatefulSet
		if err := k8sClient.Get(context.Background(), types.NamespacedName{Namespace: ns, Name: "vol"}, &ss); err != nil {
			return false, err.Error()
		}
		pod := ss.Spec.Template.Spec
		for _, name := range []string{"data", "mux", "tls"} {
			if !slices.ContainsFunc(pod.Volumes, func(volume corev1.Volume) bool { return volume.Name == name }) {
				return false, "missing volume " + name
			}
		}
		game := slices.IndexFunc(pod.Containers, func(container corev1.Container) bool { return container.Name == gameContainerName })
		if game < 0 || !slices.ContainsFunc(pod.Containers[game].VolumeMounts, func(mount corev1.VolumeMount) bool { return mount.Name == "tls" && mount.MountPath == "/certs" }) {
			return false, "game container lacks the tls mount"
		}
		sidecar := slices.IndexFunc(pod.InitContainers, func(container corev1.Container) bool { return container.Name == "signaling-mux" })
		if sidecar < 0 || len(pod.InitContainers[sidecar].VolumeMounts) != 2 || pod.InitContainers[sidecar].RestartPolicy == nil {
			return false, "sidecar missing or without its mounts"
		}
		return true, ""
	})
}
