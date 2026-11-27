package handlers

import (
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
	{name: aiBuildsList, description: "List this repository's builds, newest first, with their phase, source, artifacts and deployments, and the effective build settings.", properties: map[string]any{}},
	{name: aiBuildStart, description: "Start a build of this repository's working copy in the cluster, uncommitted changes included. Builds run one at a time. Returns the new build; follow it with build_status and build_log.", properties: map[string]any{
		"tool": map[string]any{"type": "string", "enum": []string{"auto", "maven", "gradle"}, "description": "Build tool (default: the repository's setting; auto detects it)"},
		"jdk":  map[string]any{"type": "integer", "enum": []int{17, 21, 25}, "description": "JDK version (default: the repository's setting)"},
		"args": map[string]any{"type": "string", "description": "Build tool arguments, for example -B clean package (default: the repository's setting)"},
	}},
	{name: aiBuildStatus, description: "Show one build's phase, source, artifacts and deployments.", properties: map[string]any{"build": aiBuildNumberProperty}, required: []string{"build"}},
	{name: aiBuildLog, description: "Show the last 200 lines of one build's log.", properties: map[string]any{"build": aiBuildNumberProperty}, required: []string{"build"}},
	{name: aiBuildDeploy, description: "Copy one artifact of a successful build into the plugins folder of target servers, optionally removing old jars and restarting them. Deploy only when the user names the target servers or asked through the deploy modal; after a build, report the result and stop. The user approves each deploy unless bypass permissions is on.", properties: map[string]any{
		"build":    aiBuildNumberProperty,
		"artifact": map[string]any{"type": "string", "description": "Artifact path from the build, for example target/LitHomes-1.0.0.jar"},
		"targets":  aiBuildTargets,
		"dir":      map[string]any{"type": "string", "description": "Folder relative to the data folder (default plugins)"},
		"filename": map[string]any{"type": "string", "description": "File name to write (default: the artifact's file name); must end in .jar"},
		"remove":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Jar file names in the folder to delete first, for example an older build"},
		"restart":  map[string]any{"type": "boolean", "description": "Restart each target server after the write (default false)"},
	}, required: []string{"build", "artifact", "targets"}},
}

var aiReposListTool = aiToolSpec{name: aiReposList, description: "List the repositories the user can see, with their branch, phase and owner. Use a repository name with the repository reads: git_status, git_log, git_diff and read_file.", properties: map[string]any{}}

func aiIsBuildTool(name string) bool {
	return slices.ContainsFunc(aiBuildTools, func(spec aiToolSpec) bool { return spec.name == name })
}

func aiBuildNeedsApproval(in aiToolInput) bool {
	return strings.ToUpper(in.Method) == http.MethodPost && strings.HasPrefix(in.Path, "/repositories/") &&
		strings.Contains(in.Path, "/builds/") && strings.HasSuffix(in.Path, "/deploy")
}

func aiBuildInput(conv aiConversation, name string, raw json.RawMessage) (aiToolInput, error) {
	var in struct {
		Build    int64         `json:"build"`
		Tool     string        `json:"tool"`
		JDK      int32         `json:"jdk"`
		Args     string        `json:"args"`
		Artifact string        `json:"artifact"`
		Targets  []buildTarget `json:"targets"`
		Dir      string        `json:"dir"`
		Filename string        `json:"filename"`
		Remove   []string      `json:"remove"`
		Restart  bool          `json:"restart"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &in); err != nil {
			return aiToolInput{}, fmt.Errorf("decode %s: %w", name, err)
		}
	}
	if conv.Repository == "" {
		return aiToolInput{}, errors.New("build tools work only in a repository conversation")
	}
	base := "/repositories/" + conv.Repository + "/builds"
	if name != aiBuildsList && name != aiBuildStart && in.Build < 1 {
		return aiToolInput{}, errors.New("build must be the build number")
	}
	numbered := fmt.Sprintf("%s/%d", base, in.Build)
	switch name {
	case aiBuildsList:
		return aiToolInput{Method: http.MethodGet, Path: base}, nil
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
		data, err := json.Marshal(body)
		return aiToolInput{Method: http.MethodPost, Path: base, Body: data}, err
	case aiBuildStatus:
		return aiToolInput{Method: http.MethodGet, Path: numbered}, nil
	case aiBuildLog:
		return aiToolInput{Method: http.MethodGet, Path: numbered + "/log", Query: map[string]string{"tail": "200"}}, nil
	case aiBuildDeploy:
		data, err := json.Marshal(buildDeployRequest{Artifact: in.Artifact, Targets: in.Targets, Dir: in.Dir, Filename: in.Filename, Remove: in.Remove, Restart: in.Restart})
		return aiToolInput{Method: http.MethodPost, Path: numbered + "/deploy", Body: data}, err
	}
	return aiToolInput{}, fmt.Errorf("unknown build tool %s", name)
}

var aiOtherTargetsPrompt = `Other targets: read_file and read_archive take server (with namespace, and cluster when it is not "local") or repository (with namespace) to read another server's data volume or another repository's working copy. grep, glob and shell stay on this conversation's own target. git_status, git_log and git_diff take repository (with namespace) to read another repository, and repositories_list lists the repositories you can see. You can read only what the user may read, and you never write to another target.`

var aiBuildsPrompt = `

Builds: build_start builds this repository's working copy in the cluster, uncommitted changes included; builds_list, build_status and build_log follow a build. build_deploy copies one artifact of a successful build into the plugins folder of target servers and pauses for the user's approval unless bypass permissions is on. Deploy only when the user names the target servers or asked through the deploy modal; after a build, report the result and stop.

` + aiOtherTargetsPrompt
