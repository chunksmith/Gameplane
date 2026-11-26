package controller

import (
	"testing"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

func TestAgentImageForGit(t *testing.T) {
	r := &GameServerReconciler{AgentImage: "agent", GitAgentImage: "repo-agent"}
	gs := &gameplanev1alpha1.GameServer{}
	if got := r.agentImage(gs); got != "agent" {
		t.Fatalf("plain server image %q", got)
	}
	gs.Annotations = map[string]string{gitAnnotation: "true"}
	if got := r.agentImage(gs); got != "repo-agent" {
		t.Fatalf("git server image %q", got)
	}
	r.GitAgentImage = ""
	if got := r.agentImage(gs); got != "agent" {
		t.Fatalf("git server without repo agent image %q", got)
	}
}
