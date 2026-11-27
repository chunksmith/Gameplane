package handlers

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
)

const (
	aiBuildsList  = "builds_list"
	aiBuildStart  = "build_start"
	aiBuildStatus = "build_status"
	aiBuildLog    = "build_log"
	aiBuildDeploy = "build_deploy"
	aiReposList   = "repositories_list"
)

var (
	aiBuildNumberProperty = map[string]any{"type": "integer", "description": "Build number, as builds_list shows it"}
	aiBuildTargets        = map[string]any{"type": "array", "description": "Servers to write the artifact to, up to 50", "items": map[string]any{"type": "object", "properties": map[string]any{
		"server":    map[string]any{"type": "string", "description": "Server name"},
		"namespace": map[string]any{"type": "string", "description": "The server's namespace (default: the repository's)"},
		"cluster":   map[string]any{"type": "string", "description": "The server's cluster when it is not \"local\""},
	}, "required": []string{"server"}}}
)

var aiBuildTools = []aiToolSpec{
	aiRepoSpec(aiBuildsList, "List a repository's builds, newest first, with their phase, source, artifacts and deployments, and the effective build settings.", nil, nil),
	aiRepoSpec(aiBuildStart, "Start a build of a repository's working copy in the cluster, uncommitted changes included. Builds run one at a time per repository. Returns the new build; follow it with build_status and build_log.", nil, map[string]any{
		"tool": map[string]any{"type": "string", "enum": []string{"auto", "maven", "gradle"}, "description": "Build tool (default: the repository's setting; auto detects it)"},
		"jdk":  map[string]any{"type": "integer", "enum": []int{17, 21, 25}, "description": "JDK version (default: the repository's setting)"},
		"args": map[string]any{"type": "string", "description": "Build tool arguments, for example -B clean package (default: the repository's setting)"},
	}),
	aiRepoSpec(aiBuildStatus, "Show one build's phase, source, artifacts and deployments.", []string{"build"}, map[string]any{"build": aiBuildNumberProperty}),
	aiRepoSpec(aiBuildLog, "Show the last 200 lines of one build's log.", []string{"build"}, map[string]any{"build": aiBuildNumberProperty}),
	aiRepoSpec(aiBuildDeploy, "Copy one artifact of a successful build into the plugins folder of target servers, optionally removing old jars and restarting them. Deploy when the user asked for a fix to reach a server (in a server conversation, that server), names the target servers, or asked through the deploy modal; otherwise report the build result and stop. The user approves each deploy unless bypass permissions is on.", []string{"build", "artifact", "targets"}, map[string]any{
		"build":    aiBuildNumberProperty,
		"artifact": map[string]any{"type": "string", "description": "Artifact path from the build, for example target/LitHomes-1.0.0.jar"},
		"targets":  aiBuildTargets,
		"dir":      map[string]any{"type": "string", "description": "Folder relative to the data folder (default plugins)"},
		"filename": map[string]any{"type": "string", "description": "File name to write (default: the artifact's file name); must end in .jar"},
		"remove":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Jar file names in the folder to delete first, for example an older build"},
		"restart":  map[string]any{"type": "boolean", "description": "Restart each target server after the write (default false)"},
	}),
}

var aiReposListTool = aiToolSpec{name: aiReposList, description: "List the repositories the user can see, with their branch, phase and owner. Pass a repository name and its namespace to the file, git and build tools.", properties: map[string]any{}}

func aiIsBuildTool(name string) bool {
	return slices.ContainsFunc(aiBuildTools, func(spec aiToolSpec) bool { return spec.name == name })
}

func aiBuildNeedsApproval(in aiToolInput) bool {
	return strings.ToUpper(in.Method) == http.MethodPost && strings.HasPrefix(in.Path, "/repositories/") &&
		strings.Contains(in.Path, "/builds/") && strings.HasSuffix(in.Path, "/deploy")
}

func aiBuildInput(conv aiConversation, name string, raw json.RawMessage) (aiToolInput, error) {
	var in struct {
		Repository string        `json:"repository"`
		Namespace  string        `json:"namespace"`
		Build      int64         `json:"build"`
		Tool       string        `json:"tool"`
		JDK        int32         `json:"jdk"`
		Args       string        `json:"args"`
		Artifact   string        `json:"artifact"`
		Targets    []buildTarget `json:"targets"`
		Dir        string        `json:"dir"`
		Filename   string        `json:"filename"`
		Remove     []string      `json:"remove"`
		Restart    bool          `json:"restart"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &in); err != nil {
			return aiToolInput{}, fmt.Errorf("decode %s: %w", name, err)
		}
	}
	if in.Repository != "" && !dnsLabelRE.MatchString(in.Repository) {
		return aiToolInput{}, errors.New("repository must be a repository name")
	}
	repository := cmp.Or(in.Repository, conv.Repository)
	if repository == "" {
		return aiToolInput{}, errors.New("repository is required outside a repository conversation")
	}
	base := "/repositories/" + repository + "/builds"
	if name != aiBuildsList && name != aiBuildStart && in.Build < 1 {
		return aiToolInput{}, errors.New("build must be the build number")
	}
	numbered := fmt.Sprintf("%s/%d", base, in.Build)
	out := aiToolInput{Method: http.MethodGet, Query: map[string]string{}}
	var err error
	switch name {
	case aiBuildsList:
		out.Path = base
	case aiBuildStart:
		body := map[string]any{}
		if in.Tool != "" {
			body["tool"] = in.Tool
		}
		if in.JDK != 0 {
			body["jdk"] = in.JDK
		}
		if in.Args != "" {
			body["args"] = in.Args
		}
		out.Method, out.Path = http.MethodPost, base
		out.Body, err = json.Marshal(body)
	case aiBuildStatus:
		out.Path = numbered
	case aiBuildLog:
		out.Path, out.Query["tail"] = numbered+"/log", "200"
	case aiBuildDeploy:
		out.Method, out.Path = http.MethodPost, numbered+"/deploy"
		out.Body, err = json.Marshal(buildDeployRequest{Artifact: in.Artifact, Targets: in.Targets, Dir: in.Dir, Filename: in.Filename, Remove: in.Remove, Restart: in.Restart})
	default:
		return aiToolInput{}, fmt.Errorf("unknown build tool %s", name)
	}
	if repository != conv.Repository {
		out.Query["namespace"] = cmp.Or(in.Namespace, conv.Namespace)
	}
	return out, err
}

var aiOtherTargetsPrompt = `Other targets: you can work on every server and repository the user may access, not only this conversation's own; the API enforces the user's permissions on each call. The server tools, shell, grep, glob and the file tools take server with namespace (and cluster when it is not "local"); the file tools, the git tools and the build tools take repository with namespace. servers_list and repositories_list find them. When the user reports a bug in a plugin, find its source with repositories_list (the repository named after the plugin, or the one whose plugin.yml names it), fix it there with the file tools and repository, build it with build_start, then deploy the new jar with build_deploy to the servers that run it (in a server conversation, that server), removing the old jar. Commit and push only when the user asks.`

var aiBuildsPrompt = `

Builds: build_start builds this repository's working copy in the cluster, uncommitted changes included; builds_list, build_status and build_log follow a build. build_deploy copies one artifact of a successful build into the plugins folder of target servers and pauses for the user's approval unless bypass permissions is on. Deploy when the user asked for the fix to reach a server, names the target servers or asked through the deploy modal; otherwise, after a build, report the result and stop.

` + aiOtherTargetsPrompt
