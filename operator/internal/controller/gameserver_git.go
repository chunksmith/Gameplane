package controller

import gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"

const gitAnnotation = "gameplane.local/git"

func (r *GameServerReconciler) agentImage(gs *gameplanev1alpha1.GameServer) string {
	if gs.Annotations[gitAnnotation] == "true" && r.GitAgentImage != "" {
		return r.GitAgentImage
	}
	return r.AgentImage
}
