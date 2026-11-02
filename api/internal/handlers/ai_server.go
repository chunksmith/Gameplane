package handlers

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
)

const (
	aiServersList  = "servers_list"
	aiServerStatus = "server_status"
	aiServerPower  = "server_power"
	aiModsList     = "mods_list"
	aiModsInstall  = "mods_install"
	aiModsRemove   = "mods_remove"
	aiPlayersList  = "players_list"
	aiPlayerAction = "player_action"
	aiRunAction    = "run_action"
	aiBackupsList  = "backups_list"
	aiBackupCreate = "backup_create"
)

var (
	aiServerReads   = []string{aiServersList, aiServerStatus, aiModsList, aiPlayersList, aiBackupsList}
	aiPowerActions  = []string{"start", "stop", "restart", "wake"}
	aiPlayerOps     = []string{"kick", "ban", "unban", "whitelist_add", "whitelist_remove"}
	aiPlayerActions = map[string]string{"kick": "/players/kick", "ban": "/players/ban", "unban": "/players/unban", "whitelist_add": "/players/whitelist/add", "whitelist_remove": "/players/whitelist/remove"}
)

var aiServerTools = []aiToolSpec{
	{name: aiServersList, description: "List every server the user can see, across clusters, with the namespace and cluster the other server tools need.", properties: map[string]any{}},
	aiScopedSpec(aiServerStatus, "Show a server's live status from its agent, or with events its recent Kubernetes pod events (scheduling, image pulls, crashes).", nil, map[string]any{
		"events": map[string]any{"type": "boolean", "description": "Show the pod events instead of the status"},
	}),
	aiScopedSpec(aiServerPower, "Start, stop, restart or wake a server. Stop or restart only when the user asks or a change needs it.", []string{"action"}, map[string]any{
		"action": map[string]any{"type": "string", "enum": aiPowerActions},
	}),
	aiScopedSpec(aiModsList, "List the plugins or mods installed on a server, or with updates the updates available for them.", nil, map[string]any{
		"updates": map[string]any{"type": "boolean", "description": "List available updates instead"},
	}),
	aiScopedSpec(aiModsInstall, "Download a plugin or mod from url into the server's plugins or mods folder. The URL host must be in the template's spec.capabilities.mods.install.allowedHosts, otherwise HTTP 403.", []string{"url"}, map[string]any{
		"url":  map[string]any{"type": "string", "description": "Direct download URL of the file"},
		"name": map[string]any{"type": "string", "description": "File name to save it as (default: taken from the URL)"},
	}),
	aiScopedSpec(aiModsRemove, "Remove an installed plugin or mod file by the name mods_list shows. Needs the user's approval unless bypass permissions is on.", []string{"name"}, map[string]any{
		"name": map[string]any{"type": "string", "description": "File name, for example EssentialsX-2.21.0.jar"},
	}),
	aiScopedSpec(aiPlayersList, "List a server's online players, or with whitelist its whitelist.", nil, map[string]any{
		"whitelist": map[string]any{"type": "boolean", "description": "List the whitelist instead"},
	}),
	aiScopedSpec(aiPlayerAction, "Kick, ban or unban a player, or add or remove a player on the whitelist.", []string{"action", "player"}, map[string]any{
		"action": map[string]any{"type": "string", "enum": aiPlayerOps},
		"player": map[string]any{"type": "string", "description": "Player name"},
		"reason": map[string]any{"type": "string", "description": "Reason shown for a kick or ban"},
	}),
	aiScopedSpec(aiRunAction, "Run one of the server template's actions. The template (GET /templates/{spec.templateRef.name} through gameplane_api) lists them and their parameters under spec.capabilities.actions.", []string{"id"}, map[string]any{
		"id":     map[string]any{"type": "string", "description": "Action id"},
		"params": map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}, "description": "Action parameters"},
	}),
	aiScopedSpec(aiBackupsList, "List backups: in a server conversation that server's, otherwise every backup in the namespace. Read one with GET /backups/{name} and delete one with DELETE /backups/{name} through gameplane_api.", nil, nil),
	aiScopedSpec(aiBackupCreate, "Start a manual backup of a server.", nil, nil),
}

func aiIsServerTool(name string) bool {
	return slices.ContainsFunc(aiServerTools, func(spec aiToolSpec) bool { return spec.name == name })
}

func aiScopeTools(conv aiConversation) []aiToolSpec {
	if conv.Repository != "" {
		return aiGitTools
	}
	return aiServerTools
}

func aiCallInput(conv aiConversation, name string, raw json.RawMessage) (aiToolInput, error) {
	switch {
	case aiIsGitTool(name):
		return aiGitInput(conv.Repository, name, raw)
	case aiIsServerTool(name):
		return aiServerInput(conv, name, raw)
	}
	var in aiToolInput
	err := json.Unmarshal(raw, &in)
	return in, err
}

func aiServerInput(conv aiConversation, name string, raw json.RawMessage) (aiToolInput, error) {
	var in struct {
		Server    string            `json:"server"`
		Namespace string            `json:"namespace"`
		Cluster   string            `json:"cluster"`
		Events    bool              `json:"events"`
		Action    string            `json:"action"`
		Updates   bool              `json:"updates"`
		URL       string            `json:"url"`
		Name      string            `json:"name"`
		Whitelist bool              `json:"whitelist"`
		Player    string            `json:"player"`
		Reason    string            `json:"reason"`
		ID        string            `json:"id"`
		Params    map[string]string `json:"params"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &in); err != nil {
			return aiToolInput{}, fmt.Errorf("decode %s: %w", name, err)
		}
	}
	if conv.Repository != "" {
		return aiToolInput{}, errors.New("server tools are not available in a repository conversation")
	}
	if name == aiServersList {
		return aiToolInput{Method: http.MethodGet, Path: "/fleet/servers"}, nil
	}
	if err := aiCheckServer(conv, aiFileInput{Server: in.Server, Namespace: in.Namespace}); err != nil {
		return aiToolInput{}, err
	}
	server := cmp.Or(conv.Server, in.Server)
	base := "/servers/" + server
	query := map[string]string{}
	if conv.Server == "" {
		query["namespace"] = in.Namespace
		if in.Cluster != "" {
			query["cluster"] = in.Cluster
		}
	}
	get := aiToolInput{Method: http.MethodGet, Query: query}
	switch name {
	case aiServerStatus:
		get.Path = base + "/status"
		if in.Events {
			get.Path = base + "/events"
		}
		return get, nil
	case aiModsList:
		get.Path = base + "/mods"
		if in.Updates {
			get.Path += "/updates"
		}
		return get, nil
	case aiPlayersList:
		get.Path = base + "/players"
		if in.Whitelist {
			get.Path += "/whitelist"
		}
		return get, nil
	case aiBackupsList:
		get.Path = "/backups"
		return get, nil
	case aiModsRemove:
		query["name"] = in.Name
		return aiToolInput{Method: http.MethodDelete, Path: base + "/mods", Query: query}, nil
	case aiServerPower:
		if !slices.Contains(aiPowerActions, in.Action) {
			return aiToolInput{}, errors.New("action must be start, stop, restart or wake")
		}
		return aiToolInput{Method: http.MethodPost, Path: base + ":" + in.Action, Query: query}, nil
	}
	var target string
	var body any
	switch name {
	case aiModsInstall:
		target, body = base+"/mods/install", map[string]string{"url": in.URL, "name": in.Name}
	case aiPlayerAction:
		op, ok := aiPlayerActions[in.Action]
		if !ok {
			return aiToolInput{}, errors.New("action must be kick, ban, unban, whitelist_add or whitelist_remove")
		}
		target, body = base+op, map[string]string{"name": in.Player, "reason": in.Reason}
	case aiRunAction:
		target, body = base+"/actions/run", map[string]any{"id": in.ID, "params": in.Params}
	default:
		target, body = "/backups", map[string]any{"apiVersion": "gameplane.local/v1alpha1", "kind": "Backup", "metadata": map[string]string{"generateName": server + "-manual-"}, "spec": map[string]any{"serverRef": map[string]string{"name": server}}}
	}
	data, err := json.Marshal(body)
	if err != nil {
		return aiToolInput{}, fmt.Errorf("encode %s: %w", name, err)
	}
	return aiToolInput{Method: http.MethodPost, Path: target, Query: query, Body: data}, nil
}
