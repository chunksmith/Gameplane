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

func TestGitAgentRunsAsGameUser(t *testing.T) {
	tmpl := &gameplanev1alpha1.GameTemplate{}
	gs := &gameplanev1alpha1.GameServer{}
	if uid := *buildAgentContainer(gs, tmpl, nil, "agent", "", "").SecurityContext.RunAsUser; uid != 65532 {
		t.Fatalf("plain agent uid %d", uid)
	}
	gs.Annotations = map[string]string{gitAnnotation: "true"}
	if uid := *buildAgentContainer(gs, tmpl, nil, "agent", "", "").SecurityContext.RunAsUser; uid != 0 {
		t.Fatalf("git agent uid %d", uid)
	}
	game := int64(1000)
	tmpl.Spec.Security = &gameplanev1alpha1.GameSecuritySpec{RunAsUser: &game}
	if uid := *buildAgentContainer(gs, tmpl, nil, "agent", "", "").SecurityContext.RunAsUser; uid != game {
		t.Fatalf("git agent uid %d, want template uid", uid)
	}
}
