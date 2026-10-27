package handlers

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
)

func TestAIRepositoryScope(t *testing.T) {
	conv := aiConversation{Repository: "site", Namespace: "games", Cluster: "local", Mode: aiModeDefault}
	h := &aiHandler{}
	for _, c := range []struct {
		method, path, want string
	}{
		{"GET", "/repositories/site/git/status", "/repositories/site/git/status?namespace=games"},
		{"POST", "/repositories/site/files/write", "/repositories/site/files/write?namespace=games"},
		{"GET", "/repositories/other/git/status", ""},
		{"GET", "/repositories/site", ""},
		{"GET", "/servers/lobby", ""},
		{"GET", "/repositories/site/files/download", ""},
	} {
		got, err := h.authorize(t.Context(), conv, aiCreds{}, c.method, aiToolInput{Method: c.method, Path: c.path})
		if (c.want == "") != (err != nil) || (err == nil && got != c.want) {
			t.Errorf("authorize %s %s = %q, %v", c.method, c.path, got, err)
		}
	}
	for _, c := range []struct {
		in   aiToolInput
		want bool
	}{
		{aiToolInput{Method: "POST", Path: "/repositories/site/git/push"}, true},
		{aiToolInput{Method: "POST", Path: "/repositories/site/git/pull"}, true},
		{aiToolInput{Method: "POST", Path: "/repositories/site/git/discard"}, true},
		{aiToolInput{Method: "POST", Path: "/repositories/site/git/undo"}, true},
		{aiToolInput{Method: "POST", Path: "/repositories/site/git/revert"}, true},
		{aiToolInput{Method: "POST", Path: "/repositories/site/git/commit", Body: json.RawMessage(`{"summary":"x","push":true}`)}, true},
		{aiToolInput{Method: "POST", Path: "/repositories/site/git/commit", Body: json.RawMessage(`{"summary":"x"}`)}, false},
		{aiToolInput{Method: "POST", Path: "/repositories/site/git/commit", Body: json.RawMessage(`"{\"summary\":\"x\",\"push\":true}"`)}, true},
		{aiToolInput{Method: "POST", Path: "/repositories/site/git/commit", Body: json.RawMessage(`"{\"summary\":\"x\"}"`)}, false},
		{aiToolInput{Method: "POST", Path: "/repositories/site/git/commit", Body: json.RawMessage(`"[1]"`)}, true},
		{aiToolInput{Method: "POST", Path: "/repositories/site/git/stage"}, false},
		{aiToolInput{Method: "DELETE", Path: "/repositories/site/files/delete"}, true},
	} {
		if c.in.needsApproval() != c.want {
			t.Errorf("needsApproval(%s) != %v", c.in.Path, c.want)
		}
	}
	msgs := []json.RawMessage{json.RawMessage(`{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"git_push","input":{}},{"type":"tool_use","id":"t2","name":"git_diff","input":{"path":"a.txt","staged":true}}]}`)}
	uses := aiToolUsesIn("site", msgs)
	if len(uses) != 2 || !uses[0].needsApproval() || uses[0].target() != "/repositories/site/git/push" || uses[0].method() != http.MethodPost {
		t.Fatalf("git_push use = %+v", uses)
	}
	if uses[1].needsApproval() || uses[1].input.Query["path"] != "a.txt" || uses[1].input.Query["staged"] != "true" {
		t.Errorf("git_diff use = %+v", uses[1].input)
	}
	if uses := aiToolUses(msgs); uses[0].err == nil {
		t.Error("git tool outside a repository conversation")
	}
	if in, err := aiGitInput("site", aiGitLog, json.RawMessage(`{"limit":999}`)); err != nil || in.Query["limit"] != "200" {
		t.Errorf("git_log limit = %+v %v", in, err)
	}
	if in, err := aiGitInput("site", aiGitCommit, json.RawMessage(`{"summary":"fix"}`)); err != nil || strings.Contains(string(in.Body), "push") {
		t.Errorf("git_commit must not push: %s %v", in.Body, err)
	}
	args := aiCLIArgs(conv, "http://127.0.0.1:1/mcp", "tok", true)
	allowed := args[slices.Index(args, "--allowedTools")+1]
	if !hasArg(args, "--tools", "") || strings.Contains(allowed, "Bash") || !strings.Contains(allowed, aiMCPPrefix+aiGitPush) {
		t.Errorf("repository CLI args = %v", args)
	}
	if prompt := aiSystemPrompt(conv); !strings.Contains(prompt, `repository "site"`) || strings.Contains(prompt, "kubectl") {
		t.Error("repository prompt")
	}
	if names := len(aiBetaToolsFor(conv)) - len(aiBetaTools()); names != len(aiGitTools) {
		t.Errorf("git tools in repository scope = %d", names)
	}
	if err := aiCheckFile(conv, aiFileInput{Path: "/a", Server: "lobby"}); err == nil {
		t.Error("server file in repository conversation")
	}
}
