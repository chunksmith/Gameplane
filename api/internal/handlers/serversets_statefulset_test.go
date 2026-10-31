package handlers

import (
	"context"
	"reflect"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/prom"
	"github.com/GameplanePanel/gameplane/api/internal/rbac"
)

func replicaPortsSet(ips ...any) *unstructured.Unstructured {
	port := map[string]any{"name": "voice", "basePort": int64(7200)}
	if len(ips) > 0 {
		port["externalIPs"] = ips
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"spec": map[string]any{"replicaPorts": []any{port}},
	}}
}

func TestServerSetExternalIPsNeedAdmin(t *testing.T) {
	viewer := auth.WithUser(context.Background(), &auth.User{Role: "viewer"})
	admin := auth.WithUser(context.Background(), &auth.User{Role: rbac.RoleAdmin})
	withIPs := replicaPortsSet("203.0.113.10")
	if isClusterAdmin(viewer, "default", "games") {
		t.Fatal("viewer role treated as admin")
	}
	if !isClusterAdmin(admin, "default", "games") {
		t.Fatal("admin role not treated as admin")
	}
	if got := serverSetExternalIPs(withIPs)["voice"]; len(got) != 1 || got[0] != "203.0.113.10" {
		t.Errorf("external IPs = %v", got)
	}
	if len(serverSetExternalIPs(replicaPortsSet())) != 0 {
		t.Error("port without externalIPs reported IPs")
	}
	if !serverSetExternalIPsEqual(withIPs, replicaPortsSet("203.0.113.10")) {
		t.Error("identical external IPs reported changed")
	}
	if serverSetExternalIPsEqual(withIPs, replicaPortsSet("203.0.113.11")) {
		t.Error("changed external IPs reported equal")
	}
}

func TestProtectServerOwnership(t *testing.T) {
	desired := &unstructured.Unstructured{Object: map[string]any{}}
	desired.SetLabels(map[string]string{
		"gameplane.local/server-set-statefulset": "victim",
		"gameplane.local/server-set":             "victim",
		"backup-group.gameplane.local/lfln":      "enabled",
	})
	controller := true
	desired.SetOwnerReferences([]metav1.OwnerReference{{Kind: "GameServerSet", Name: "victim", UID: "uid", Controller: &controller}})
	protectServerOwnership(desired, nil)
	labels := desired.GetLabels()
	if labels["gameplane.local/server-set-statefulset"] != "" || labels["gameplane.local/server-set"] != "" {
		t.Errorf("set labels kept on create: %v", labels)
	}
	if labels["backup-group.gameplane.local/lfln"] != "enabled" {
		t.Errorf("user label dropped: %v", labels)
	}
	if len(desired.GetOwnerReferences()) != 0 {
		t.Errorf("owner references kept on create: %v", desired.GetOwnerReferences())
	}

	live := &unstructured.Unstructured{Object: map[string]any{}}
	live.SetLabels(map[string]string{"gameplane.local/server-set": "smp", "gameplane.local/server-set-statefulset": "smp"})
	live.SetOwnerReferences([]metav1.OwnerReference{{Kind: "GameServerSet", Name: "smp", UID: "smp-uid", Controller: &controller}})
	update := &unstructured.Unstructured{Object: map[string]any{}}
	protectServerOwnership(update, live)
	if update.GetLabels()["gameplane.local/server-set-statefulset"] != "smp" || len(update.GetOwnerReferences()) != 1 {
		t.Errorf("live ownership not restored: %v %v", update.GetLabels(), update.GetOwnerReferences())
	}
}

func TestAdminSpecFieldsKeepLiveForNonAdmins(t *testing.T) {
	viewer := auth.WithUser(context.Background(), &auth.User{Role: "viewer"})
	admin := auth.WithUser(context.Background(), &auth.User{Role: rbac.RoleAdmin})
	envFrom := []any{map[string]any{"configMapRef": map[string]any{"name": "global-env"}}}
	spec := func(fields map[string]any) *unstructured.Unstructured {
		spec := map[string]any{"templateRef": map[string]any{"name": "minecraft"}}
		for key, value := range fields {
			spec[key] = value
		}
		return &unstructured.Unstructured{Object: map[string]any{"spec": spec}}
	}
	if err := validateAndProtectGameServer(viewer, nil, "default", "games", "smp", spec(map[string]any{"envFrom": envFrom}), nil); err == nil {
		t.Error("viewer created a server with envFrom")
	}
	if err := validateAndProtectGameServer(admin, nil, "default", "games", "smp", spec(map[string]any{"envFrom": envFrom}), nil); err != nil {
		t.Errorf("admin envFrom rejected: %v", err)
	}
	live := spec(map[string]any{"envFrom": envFrom, "podLabels": map[string]any{"app": "smp"}})
	desired := spec(nil)
	if err := validateAndProtectGameServer(viewer, nil, "default", "games", "smp", desired, live); err != nil {
		t.Fatalf("viewer update without admin fields rejected: %v", err)
	}
	if got, _, _ := unstructured.NestedSlice(desired.Object, "spec", "envFrom"); len(got) != 1 {
		t.Errorf("live envFrom not restored: %v", got)
	}
	if got, _, _ := unstructured.NestedStringMap(desired.Object, "spec", "podLabels"); got["app"] != "smp" {
		t.Errorf("live podLabels not restored: %v", got)
	}
	changed := spec(map[string]any{"envFrom": envFrom, "podLabels": map[string]any{"app": "other"}})
	if err := validateAndProtectGameServer(viewer, nil, "default", "games", "smp", changed, live); err == nil {
		t.Error("viewer changed podLabels")
	}
}

func TestStatisticsRowsMapReplicaPods(t *testing.T) {
	cpu := func(pod string, value float64) prom.Sample {
		return prom.Sample{Labels: map[string]string{"namespace": "games", "pod": pod}, Value: value}
	}
	samples := serverSamples{
		cpu:      []prom.Sample{cpu("lobby-0", 1), cpu("smp-0", 2), cpu("smp-3", 3)},
		replicas: map[string]bool{"games/smp-0": true, "games/smp-3": true},
	}
	got := map[string]float64{}
	for _, row := range samples.rows() {
		if row.CPU != nil {
			got[row.Name] = *row.CPU
		}
	}
	want := map[string]float64{"lobby": 1, "smp-0": 2, "smp-3": 3}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("rows = %v, want %v", got, want)
	}
}
