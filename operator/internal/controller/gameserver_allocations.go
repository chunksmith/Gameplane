package controller

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

const allocationLabel = "gameplane.local/allocation-of"

func allocationServiceName(gs *gameplanev1alpha1.GameServer, name string) string {
	return gs.Name + "-alloc-" + name
}

func allocationProtocol(allocation gameplanev1alpha1.PortAllocation) corev1.Protocol {
	if allocation.Protocol == "" {
		return corev1.ProtocolTCP
	}
	return allocation.Protocol
}

func (r *GameServerReconciler) reconcileAllocations(ctx context.Context, gs *gameplanev1alpha1.GameServer) error {
	wanted := make(map[string]bool, len(gs.Spec.Networking.Allocations))
	for _, allocation := range gs.Spec.Networking.Allocations {
		svc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{
			Name:      allocationServiceName(gs, allocation.Name),
			Namespace: gs.Namespace,
		}}
		wanted[svc.Name] = true
		_, err := controllerutil.CreateOrUpdate(ctx, r.Client, svc, func() error {
			if svc.Labels == nil {
				svc.Labels = map[string]string{}
			}
			svc.Labels[allocationLabel] = gs.Name
			svc.Spec.Type = corev1.ServiceTypeLoadBalancer
			svc.Spec.ExternalTrafficPolicy = corev1.ServiceExternalTrafficPolicyLocal
			svc.Spec.Selector = map[string]string{
				"app.kubernetes.io/name":     "gameplane-game",
				"app.kubernetes.io/instance": gs.Name,
			}
			nodePort := int32(0)
			if len(svc.Spec.Ports) == 1 && svc.Spec.Ports[0].Port == allocation.Port {
				nodePort = svc.Spec.Ports[0].NodePort
			}
			svc.Spec.Ports = []corev1.ServicePort{{
				Name:       allocation.Name,
				Port:       allocation.Port,
				TargetPort: intstr.FromInt32(allocation.Port),
				Protocol:   allocationProtocol(allocation),
				NodePort:   nodePort,
			}}
			return controllerutil.SetControllerReference(gs, svc, r.Scheme)
		})
		if err != nil {
			return fmt.Errorf("reconcile allocation %q: %w", allocation.Name, err)
		}
	}

	var existing corev1.ServiceList
	if err := r.List(ctx, &existing, client.InNamespace(gs.Namespace), client.MatchingLabels{allocationLabel: gs.Name}); err != nil {
		return fmt.Errorf("list allocation services: %w", err)
	}
	for i := range existing.Items {
		svc := &existing.Items[i]
		if wanted[svc.Name] || !metav1.IsControlledBy(svc, gs) {
			continue
		}
		if err := r.Delete(ctx, svc); client.IgnoreNotFound(err) != nil {
			return fmt.Errorf("delete allocation service %q: %w", svc.Name, err)
		}
	}
	return nil
}

func allocationPolicyPorts(gs *gameplanev1alpha1.GameServer) []networkingv1.NetworkPolicyPort {
	out := make([]networkingv1.NetworkPolicyPort, 0, len(gs.Spec.Networking.Allocations))
	for _, allocation := range gs.Spec.Networking.Allocations {
		protocol := allocationProtocol(allocation)
		port := intstr.FromInt32(allocation.Port)
		out = append(out, networkingv1.NetworkPolicyPort{Protocol: &protocol, Port: &port})
	}
	return out
}

func (r *GameServerReconciler) allocationEndpoints(
	ctx context.Context, gs *gameplanev1alpha1.GameServer,
) []gameplanev1alpha1.GameServerEndpoint {
	if len(gs.Spec.Networking.Allocations) == 0 {
		return nil
	}
	out := make([]gameplanev1alpha1.GameServerEndpoint, 0, len(gs.Spec.Networking.Allocations))
	for _, allocation := range gs.Spec.Networking.Allocations {
		var svc corev1.Service
		key := client.ObjectKey{Namespace: gs.Namespace, Name: allocationServiceName(gs, allocation.Name)}
		host := ""
		if err := r.Get(ctx, key, &svc); err == nil {
			host = loadBalancerAddress(&svc)
		}
		out = append(out, gameplanev1alpha1.GameServerEndpoint{
			Name:     allocation.Name,
			Host:     host,
			Port:     allocation.Port,
			Protocol: allocationProtocol(allocation),
		})
	}
	return out
}
