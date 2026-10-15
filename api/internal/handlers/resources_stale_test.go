package handlers

import (
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// usageKeys are the agent-reported resource readings that gateStaleAgent
// must drop alongside playersOnline when the heartbeat is stale.
var usageKeys = []string{
	"cpuMillicores", "cpuLimitMillicores",
	"memoryBytes", "memoryLimitBytes",
	"diskUsedBytes", "diskTotalBytes",
	"networkRxBytes", "networkTxBytes", "networkRxBytesPerSec", "networkTxBytesPerSec",
}

func gsWithHeartbeat(age time.Duration, players int64) *unstructured.Unstructured {
	agent := map[string]any{
		"lastHeartbeat": time.Now().Add(-age).UTC().Format(time.RFC3339),
		"playersOnline": players,
	}
	for _, k := range usageKeys {
		agent[k] = int64(42)
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"status": map[string]any{"agent": agent},
	}}
}

func TestGateStaleAgent_BlanksStale(t *testing.T) {
	gs := gsWithHeartbeat(5*time.Minute, 5)
	gateStaleAgent(gs)
	agent, _, _ := unstructured.NestedMap(gs.Object, "status", "agent")
	if _, ok := agent["playersOnline"]; ok {
		t.Fatalf("stale playersOnline should be dropped, got %v", agent["playersOnline"])
	}
	for _, k := range usageKeys {
		if _, ok := agent[k]; ok {
			t.Fatalf("stale %s should be dropped, got %v", k, agent[k])
		}
	}
	if agent["stale"] != true {
		t.Fatalf("expected stale=true, got %v", agent["stale"])
	}
}

func TestGateStaleAgent_KeepsFresh(t *testing.T) {
	gs := gsWithHeartbeat(2*time.Second, 5)
	gateStaleAgent(gs)
	agent, _, _ := unstructured.NestedMap(gs.Object, "status", "agent")
	// "Preserved" means the key is still present — gateStaleAgent leaves a
	// fresh agent block untouched. A present-but-null value is valid (the
	// agent patches null for an unknown reading), so assert presence, not
	// non-nil.
	if _, ok := agent["playersOnline"]; !ok {
		t.Fatal("fresh playersOnline should be preserved")
	}
	for _, k := range usageKeys {
		if _, ok := agent[k]; !ok {
			t.Fatalf("fresh %s should be preserved", k)
		}
	}
	if _, ok := agent["stale"]; ok {
		t.Fatal("fresh agent should not be marked stale")
	}
}

func TestGateStaleAgent_NoAgentNoPanic(t *testing.T) {
	gs := &unstructured.Unstructured{Object: map[string]any{
		"status": map[string]any{"phase": "Pending"},
	}}
	gateStaleAgent(gs) // must not panic or add an agent
	if _, found, _ := unstructured.NestedMap(gs.Object, "status", "agent"); found {
		t.Fatal("gateStaleAgent should not synthesize an agent block")
	}
}
