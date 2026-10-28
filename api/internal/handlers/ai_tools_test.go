package handlers

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
)

func TestAIGlobRegexp(t *testing.T) {
	for _, c := range []struct {
		pattern, path string
		want          bool
	}{
		{"*.yml", "/plugins/Essentials/config.yml", true},
		{"*.yml", "/config.json", false},
		{"plugins/**/*.yml", "/plugins/a/b/c.yml", true},
		{"plugins/**/*.yml", "/plugins/c.yml", true},
		{"plugins/**/*.yml", "/other/c.yml", false},
		{"/a/?.txt", "/a/b.txt", true},
		{"/a/?.txt", "/a/bb.txt", false},
		{"a.b", "/x/a.b", true},
		{"a+b", "/x/aab", false},
	} {
		re, err := aiGlobRegexp(c.pattern, "")
		if err != nil {
			t.Fatal(err)
		}
		if re.MatchString(c.path) != c.want {
			t.Errorf("glob %q on %q != %v", c.pattern, c.path, c.want)
		}
	}
	re, err := aiGlobRegexp("*/config.yml", "/plugins")
	if err != nil {
		t.Fatal(err)
	}
	if !re.MatchString("/plugins/Essentials/config.yml") || re.MatchString("/config.yml") {
		t.Error("glob relative to dir")
	}
}

func TestAIGrepCommand(t *testing.T) {
	command, err := aiGrepCommand(aiFileInput{Pattern: "it's", Dir: "plugins", Glob: "*.yml", IgnoreCase: true})
	if err != nil || !strings.Contains(command, "find './plugins'") || !strings.Contains(command, `-name '*.yml'`) || !strings.Contains(command, `-nHEi -e 'it'\''s'`) {
		t.Errorf("grep = %q %v", command, err)
	}
	if _, err := aiGrepCommand(aiFileInput{Dir: "/plugins"}); err == nil {
		t.Error("empty pattern accepted")
	}
	if _, err := aiGrepCommand(aiFileInput{Pattern: "x", Dir: "/.git"}); err == nil {
		t.Error("dot folder accepted")
	}
}

func TestAIListing(t *testing.T) {
	if got := aiListing(nil, "No matches."); got != "No matches." {
		t.Errorf("empty = %q", got)
	}
	if got := aiListing([]string{"/a", "/b", "/c"}, "none"); got != "/a\n/b\n/c" {
		t.Errorf("all = %q", got)
	}
	if got := aiPaths("./a:1:x\n./b\n"); !slices.Equal(got, []string{"/a:1:x", "/b"}) {
		t.Errorf("paths = %q", got)
	}
}

func TestAIJobCommands(t *testing.T) {
	id := aiJobID()
	if aiJobCheck(id) != nil || aiJobCheck("../etc") == nil {
		t.Errorf("job id %q", id)
	}
	if command := aiJobStartCommand("0123456789ab", "echo 'hi'"); !strings.Contains(command, `'echo '\''hi'\'''`) || !strings.Contains(command, "/tmp/gameplane-jobs/0123456789ab.pid") {
		t.Errorf("start = %s", command)
	}
	if command := aiJobOutputCommand("0123456789ab", 7); !strings.Contains(command, "-lt 7 ]") {
		t.Errorf("output = %s", command)
	}
	if command := aiJobStopCommand("0123456789ab"); !strings.Contains(command, "/tmp/gameplane-jobs/0123456789ab.pid") {
		t.Errorf("stop = %s", command)
	}
}

func TestAIHTMLText(t *testing.T) {
	got := aiHTMLText("<html><style>p{}</style><script>var x=1;</script><h1>Title</h1><p>a &amp; b</p>\n\n\n<p>c</p></html>")
	if got != "Title\na & b\n\nc" {
		t.Errorf("html text = %q", got)
	}
}

func TestAIPage(t *testing.T) {
	got := aiPage(strings.Repeat("é", 40005), 0, "https://x.test/")
	if !strings.HasPrefix(got, "URL: https://x.test/ (characters 0-40005 of 40005)") || strings.Contains(got, "continue with offset") {
		t.Errorf("page prefix = %.80q suffix = %q", got, got[len(got)-40:])
	}
	if got := aiPage("abc", 1, "u"); got != "URL: u (characters 1-3 of 3)\n\nbc" {
		t.Errorf("tail page = %q", got)
	}
}

func TestAIWebFetch(t *testing.T) {
	h := &aiHandler{}
	for input, want := range map[string]string{
		`{"url":"ftp://example.com/x"}`: "url must be an http or https URL",
		`{"url":"http://127.0.0.1:1/"}`: "this address is blocked",
	} {
		if got, failed := h.webFetch(t.Context(), json.RawMessage(input)); !failed || got != want {
			t.Errorf("web_fetch %s = %q %v", input, got, failed)
		}
	}
}

func TestAITodoWriteTool(t *testing.T) {
	if got, failed := aiTodoWriteTool(json.RawMessage(`{"todos":[{"content":"a","status":"in_progress"}]}`)); failed || got != "Todos updated." {
		t.Errorf("todos = %q %v", got, failed)
	}
	for _, input := range []string{`{"todos":[]}`, `{"todos":[{"content":"a","status":"done"}]}`} {
		if _, failed := aiTodoWriteTool(json.RawMessage(input)); !failed {
			t.Errorf("accepted %s", input)
		}
	}
}

func TestAIPlanBlocked(t *testing.T) {
	for _, c := range []struct {
		mode, name, input string
		want              bool
	}{
		{aiModePlan, aiEditFile, `{}`, true},
		{aiModePlan, aiWriteFile, `{}`, true},
		{aiModePlan, aiShell, `{}`, true},
		{aiModePlan, aiJobStop, `{}`, true},
		{aiModePlan, aiGrep, `{}`, false},
		{aiModePlan, aiJobOutput, `{}`, false},
		{aiModePlan, "gameplane_api", `{"method":"GET","path":"/fleet/servers"}`, false},
		{aiModePlan, "gameplane_api", `{"method":"POST","path":"/servers/a:start"}`, true},
		{aiModeDefault, aiEditFile, `{}`, false},
		{aiModeDefault, "gameplane_api", `{"method":"DELETE","path":"/backups/b"}`, false},
	} {
		if got := aiPlanBlocked(c.mode, c.name, json.RawMessage(c.input)); got != c.want {
			t.Errorf("blocked(%s, %s, %s) = %v", c.mode, c.name, c.input, got)
		}
	}
}

func TestAIParentMessages(t *testing.T) {
	top := json.RawMessage(`{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Task","input":{}}]}`)
	sub := json.RawMessage(`{"role":"assistant","parent":"t1","content":[{"type":"tool_use","id":"s1","name":"read_file","input":{"file_path":"/a"}}]}`)
	if uses := aiToolUses([]json.RawMessage{top, sub}); len(uses) != 1 || uses[0].id != "t1" {
		t.Errorf("uses = %+v", uses)
	}
	data, ok := aiCLIMessage("assistant", json.RawMessage(`{"content":[{"type":"text","text":"hi"}]}`), "t1")
	if !ok || !strings.Contains(string(data), `"parent":"t1"`) {
		t.Errorf("parented = %s", data)
	}
	data, ok = aiCLIMessage("user", json.RawMessage(`{"content":[{"type":"text","text":"hi"}]}`), "")
	if !ok || strings.Contains(string(data), "parent") {
		t.Errorf("top level = %s", data)
	}
}

func TestAIPendingIDLocal(t *testing.T) {
	ask := json.RawMessage(`{"role":"assistant","content":[{"type":"tool_use","id":"ask1","name":"ask_user","input":{"question":"q"}}]}`)
	plan := json.RawMessage(`{"role":"assistant","content":[{"type":"tool_use","id":"plan1","name":"propose_plan","input":{"plan":"p"}}]}`)
	if got := aiPendingID([]json.RawMessage{ask}, aiToolInput{Method: aiAskMethod}); got != "ask1" {
		t.Errorf("ask = %q", got)
	}
	if got := aiPendingID([]json.RawMessage{ask}, aiToolInput{Method: aiPlanMethod}); got != "" {
		t.Errorf("ask as plan = %q", got)
	}
	if got := aiPendingID([]json.RawMessage{plan}, aiToolInput{Method: aiPlanMethod}); got != "plan1" {
		t.Errorf("plan = %q", got)
	}
}

func TestAICLIArgsPlan(t *testing.T) {
	args := aiCLIArgs(aiConversation{Model: "claude-opus-5-5", Effort: "medium", Mode: aiModePlan}, "http://127.0.0.1:1/mcp", "tok", true)
	allowed := args[slices.Index(args, "--allowedTools")+1]
	system := args[slices.Index(args, "--system-prompt")+1]
	if !hasArg(args, "--tools", "Task,WebSearch") || strings.Contains(allowed, "Bash") || !strings.Contains(system, "Plan mode is on") || !strings.Contains(allowed, "mcp__gameplane__propose_plan") {
		t.Errorf("plan args = %v", args)
	}
}

func TestAICLIAskUser(t *testing.T) {
	var mu sync.Mutex
	var result string
	f, _ := newCLIFixture(t, func(call *aiSpawn, emit func(string)) {
		emit(cliInit)
		emit(cliAssistant(`{"type":"tool_use","id":"tu1","name":"` + aiMCPPrefix + aiAskUser + `","input":{"question":"Which?","options":[{"label":"a"},{"label":"b"}]}}`))
		emit(cliBarrier)
		text := cliCall(t, call.args, aiAskUser, map[string]any{"question": "Which?", "options": []map[string]string{{"label": "a"}, {"label": "b"}}})
		mu.Lock()
		result = text
		mu.Unlock()
		emit(cliToolResult("tu1", text))
		emit(cliDone)
	})
	conv := f.create(map[string]any{"prompt": "pick one"})
	f.wait(conv.ID, aiAwaiting)
	if _, _, pending := f.detail(conv.ID, ""); len(pending) != 1 || pending[0]["id"] != "tu1" || pending[0]["method"] != aiAskMethod {
		t.Fatalf("pending = %v", pending)
	}
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/answer", "", map[string]string{"answer": " a "}); rr.Code != http.StatusNoContent {
		t.Fatalf("answer = %d %s", rr.Code, rr.Body.String())
	}
	f.wait(conv.ID, aiIdle)
	mu.Lock()
	got := result
	mu.Unlock()
	if got != "The user answered: a" {
		t.Errorf("result = %q", got)
	}
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/answer", "", map[string]string{"answer": "b"}); rr.Code != http.StatusConflict {
		t.Errorf("second answer = %d", rr.Code)
	}
}
