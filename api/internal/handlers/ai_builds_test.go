package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestAIBuildAuthorize(t *testing.T) {
	conv := aiConversation{Repository: "site", Namespace: "games", Cluster: "local", Mode: aiModeDefault}
	h := &aiHandler{}
	for _, c := range []struct {
		method, path, want string
	}{
		{"GET", "/repositories/site/builds", "/repositories/site/builds?namespace=games"},
		{"POST", "/repositories/site/builds", "/repositories/site/builds?namespace=games"},
		{"GET", "/repositories/site/builds/3/log", "/repositories/site/builds/3/log?namespace=games"},
		{"POST", "/repositories/site/builds/3/deploy", "/repositories/site/builds/3/deploy?namespace=games"},
		{"POST", "/repositories/site/builds:clear-cache", ""},
		{"GET", "/repositories/other/builds", ""},
		{"POST", "/repositories/other/builds/1/deploy", ""},
		{"POST", "/repositories/other/files/write", ""},
		{"GET", "/repositories/other/files/read", "/repositories/other/files/read"},
		{"GET", "/repositories/other/git/log", "/repositories/other/git/log"},
		{"GET", "/repositories", "/repositories"},
		{"GET", "/servers/lobby/files/read", "/servers/lobby/files/read"},
		{"POST", "/servers/lobby/files/write", ""},
		{"GET", "/servers/lobby/files/download", ""},
	} {
		got, err := h.authorize(t.Context(), conv, aiCreds{}, c.method, aiToolInput{Method: c.method, Path: c.path})
		if (c.want == "") != (err != nil) || (err == nil && !strings.HasPrefix(got, c.want)) {
			t.Errorf("authorize %s %s = %q, %v; want %q", c.method, c.path, got, err, c.want)
		}
	}
}

func TestAIBuildApprovalAndPlanMode(t *testing.T) {
	for _, c := range []struct {
		in   aiToolInput
		want bool
	}{
		{aiToolInput{Method: "POST", Path: "/repositories/site/builds/3/deploy"}, true},
		{aiToolInput{Method: "POST", Path: "/repositories/site/builds"}, false},
		{aiToolInput{Method: "GET", Path: "/repositories/site/builds/3/deploy"}, false},
	} {
		if c.in.needsApproval() != c.want {
			t.Errorf("needsApproval(%s %s) != %v", c.in.Method, c.in.Path, c.want)
		}
	}
	for name, want := range map[string]bool{aiBuildStart: true, aiBuildDeploy: true, aiBuildsList: false, aiBuildStatus: false, aiBuildLog: false} {
		if got := aiPlanBlocked(aiModePlan, name, nil); got != want {
			t.Errorf("aiPlanBlocked(plan, %s) = %v, want %v", name, got, want)
		}
		if aiPlanBlocked(aiModeDefault, name, nil) {
			t.Errorf("aiPlanBlocked(default, %s) must not block", name)
		}
	}
}

func TestAIBuildInputs(t *testing.T) {
	conv := aiConversation{Repository: "site", Namespace: "games"}
	in, err := aiBuildInput(conv, aiBuildDeploy, json.RawMessage(`{"build":4,"artifact":"target/a.jar","targets":[{"server":"lobby"}],"restart":true}`))
	if err != nil || in.Path != "/repositories/site/builds/4/deploy" || in.Method != http.MethodPost || !strings.Contains(string(in.Body), `"restart":true`) {
		t.Errorf("build_deploy = %+v %v", in, err)
	}
	in, err = aiBuildInput(conv, aiBuildLog, json.RawMessage(`{"build":4}`))
	if err != nil || in.Query["tail"] != "200" || in.Path != "/repositories/site/builds/4/log" {
		t.Errorf("build_log = %+v %v", in, err)
	}
	if _, err := aiBuildInput(conv, aiBuildStatus, json.RawMessage(`{}`)); err == nil {
		t.Error("build_status without a build number")
	}
	if _, err := aiBuildInput(aiConversation{}, aiBuildsList, nil); err == nil {
		t.Error("build tools outside a repository conversation")
	}
}

func TestPlanDeploy(t *testing.T) {
	artifact := "target/LitHomes-1.0.0.jar"
	plan, code := planDeploy(buildDeployRequest{Artifact: artifact, Targets: []buildTarget{{Server: "lobby"}}}, artifact, "games")
	if code != "" || plan.dir != "plugins" || plan.filename != "LitHomes-1.0.0.jar" || plan.targets[0].Namespace != "games" {
		t.Fatalf("default plan = %+v %q", plan, code)
	}
	for _, c := range []struct {
		name string
		in   buildDeployRequest
		want string
	}{
		{"no targets", buildDeployRequest{}, buildErrBadTarget},
		{"duplicate target", buildDeployRequest{Targets: []buildTarget{{Server: "lobby"}, {Server: "lobby"}}}, buildErrBadTarget},
		{"bad server name", buildDeployRequest{Targets: []buildTarget{{Server: "Lobby"}}}, buildErrBadTarget},
		{"parent folder", buildDeployRequest{Targets: []buildTarget{{Server: "lobby"}}, Dir: "../x"}, buildErrBadPath},
		{"absolute folder", buildDeployRequest{Targets: []buildTarget{{Server: "lobby"}}, Dir: "/etc"}, buildErrBadPath},
		{"not a jar", buildDeployRequest{Targets: []buildTarget{{Server: "lobby"}}, Filename: "a.zip"}, buildErrBadPath},
		{"nested remove", buildDeployRequest{Targets: []buildTarget{{Server: "lobby"}}, Remove: []string{"old/a.jar"}}, buildErrBadPath},
		{"remove the new file", buildDeployRequest{Targets: []buildTarget{{Server: "lobby"}}, Remove: []string{"LitHomes-1.0.0.jar"}}, buildErrBadPath},
	} {
		if _, got := planDeploy(c.in, artifact, "games"); got != c.want {
			t.Errorf("%s: code %q, want %q", c.name, got, c.want)
		}
	}
}

func TestDetectBuildToolAndJobName(t *testing.T) {
	if got := detectBuildTool([]aiListEntry{{Name: "build.gradle.kts"}, {Name: "pom.xml"}}); got == nil || *got != buildToolMaven {
		t.Errorf("maven wins over gradle, got %v", got)
	}
	if got := detectBuildTool([]aiListEntry{{Name: "build.gradle"}}); got == nil || *got != buildToolGradle {
		t.Errorf("gradle detected = %v", got)
	}
	if got := detectBuildTool([]aiListEntry{{Name: "pom.xml", Dir: true}}); got != nil {
		t.Errorf("a folder named pom.xml is not a project: %v", *got)
	}
	long := strings.Repeat("a", 70)
	if job := buildJobName(long); len(job) != buildNameMax || job != buildJobName(long) {
		t.Errorf("job name = %q", job)
	}
	if buildJobName("repo-build-3") != "repo-build-3" {
		t.Error("short job names are kept")
	}
}
