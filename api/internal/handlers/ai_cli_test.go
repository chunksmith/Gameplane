package handlers

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	kubefake "k8s.io/client-go/kubernetes/fake"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
	"github.com/GameplanePanel/gameplane/api/internal/rbac"
)

const (
	cliInit    = `{"type":"system","subtype":"init","session_id":"sess-1"}`
	cliBarrier = `{"type":"system","subtype":"status"}`
	cliDone    = `{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":12,"output_tokens":4,"cache_read_input_tokens":3}}`
)

type aiSpawn struct {
	env  []string
	args []string
	in   <-chan string

	mu      sync.Mutex
	prompts []string
}

func (s *aiSpawn) sent() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.prompts)
}

func newCLIFixture(t *testing.T, script func(call *aiSpawn, emit func(string))) (*aiFixture, func() []*aiSpawn) {
	t.Helper()
	f := newAIFixture(t, true)
	f.h.key = func(context.Context) (string, bool) { return "oat-test", true }
	var spawns []*aiSpawn
	f.h.spawn = func(ctx context.Context, env []string, args ...string) (io.WriteCloser, io.ReadCloser, func() error, error) {
		in := make(chan string, 8)
		call := &aiSpawn{env: env, args: args, in: in}
		f.mu.Lock()
		spawns = append(spawns, call)
		f.mu.Unlock()
		stdinReader, stdinWriter := io.Pipe()
		outReader, outWriter := io.Pipe()
		done := make(chan struct{})
		go func() {
			defer close(in)
			scanner := bufio.NewScanner(stdinReader)
			for scanner.Scan() {
				var msg struct {
					Message struct {
						Content string `json:"content"`
					} `json:"message"`
				}
				if json.Unmarshal(scanner.Bytes(), &msg) != nil {
					continue
				}
				call.mu.Lock()
				call.prompts = append(call.prompts, msg.Message.Content)
				call.mu.Unlock()
				in <- msg.Message.Content
			}
		}()
		go func() {
			defer close(done)
			script(call, func(line string) { _, _ = io.WriteString(outWriter, line+"\n") })
			_ = outWriter.Close()
		}()
		stop := context.AfterFunc(ctx, func() {
			_ = stdinReader.Close()
			_ = outWriter.Close()
		})
		return stdinWriter, outReader, func() error { <-done; stop(); return nil }, nil
	}
	return f, func() []*aiSpawn {
		f.mu.Lock()
		defer f.mu.Unlock()
		return slices.Clone(spawns)
	}
}

func cliTurns(emit func(string), in <-chan string) {
	emit(cliInit)
	for range in {
		emit(cliDone)
	}
}

func cliAssistant(content string) string {
	return `{"type":"assistant","message":{"id":"m1","type":"message","role":"assistant","content":[` + content + `]}}`
}

func cliToolUse(id, input string) string {
	return cliAssistant(`{"type":"tool_use","id":"` + id + `","name":"` + aiMCPTool + `","input":` + input + `}`)
}

func cliToolResult(id, text string) string {
	data, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []map[string]any{{"type": "tool_result", "tool_use_id": id, "content": text}}}})
	return string(data)
}

func hasArg(args []string, flag, value string) bool {
	i := slices.Index(args, flag)
	return i >= 0 && i+1 < len(args) && args[i+1] == value
}

type headerTransport map[string]string

func (h headerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	for key, value := range h {
		req.Header.Set(key, value)
	}
	return http.DefaultTransport.RoundTrip(req)
}

func cliTool(t *testing.T, args []string, input map[string]any) string {
	t.Helper()
	return cliCall(t, args, "gameplane_api", input)
}

func cliSession(t *testing.T, args []string) *mcp.ClientSession {
	t.Helper()
	var cfg struct {
		MCPServers map[string]struct {
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
		} `json:"mcpServers"`
	}
	i := slices.Index(args, "--mcp-config")
	if i < 0 || i+1 >= len(args) || json.Unmarshal([]byte(args[i+1]), &cfg) != nil {
		t.Errorf("mcp config missing in %v", args)
		return nil
	}
	server := cfg.MCPServers["gameplane"]
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	session, err := client.Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: server.URL, HTTPClient: &http.Client{Transport: headerTransport(server.Headers)}}, nil)
	if err != nil {
		t.Errorf("connect: %v", err)
		return nil
	}
	return session
}

func cliCall(t *testing.T, args []string, name string, input map[string]any) string {
	t.Helper()
	session := cliSession(t, args)
	if session == nil {
		return ""
	}
	defer func() { _ = session.Close() }()
	res, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: input})
	if err != nil || len(res.Content) == 0 {
		t.Errorf("call tool: %v", err)
		return ""
	}
	text, ok := res.Content[0].(*mcp.TextContent)
	if !ok {
		t.Errorf("tool content = %T", res.Content[0])
		return ""
	}
	return text.Text
}

func waitUntracked(t *testing.T, h *aiHandler, id string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for h.liveRun(id) != nil {
		if time.Now().After(deadline) {
			t.Fatal("run still tracked")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestAICLIRun(t *testing.T) {
	streamed, proceed := make(chan struct{}, 1), make(chan struct{})
	f, spawns := newCLIFixture(t, func(call *aiSpawn, emit func(string)) {
		emit(cliInit)
		<-call.in
		emit(`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"All good."}}}`)
		emit(cliBarrier)
		streamed <- struct{}{}
		<-proceed
		emit(cliAssistant(`{"type":"text","text":"All good."}`))
		emit(cliDone)
		for range call.in {
			emit(cliAssistant(`{"type":"text","text":"Still good."}`))
			emit(cliDone)
		}
	})
	conv := f.create(map[string]any{"prompt": "check the fleet"})
	<-streamed
	if text := f.waitStream(conv.ID); text != "All good." {
		t.Errorf("streamed text = %q", text)
	}
	close(proceed)
	got := f.wait(conv.ID, aiIdle)
	if got.InputTokens != 15 || got.OutputTokens != 4 {
		t.Errorf("usage = %d/%d", got.InputTokens, got.OutputTokens)
	}
	var session string
	if err := f.h.store.DB.QueryRowContext(t.Context(), `SELECT session_id FROM ai_conversations WHERE id = ?`, conv.ID).Scan(&session); err != nil || session != "sess-1" {
		t.Errorf("session = %q, %v", session, err)
	}
	_, msgs, _ := f.detail(conv.ID, "")
	if len(msgs) != 2 || !strings.Contains(string(msgs[1]), "All good.") {
		t.Fatalf("messages = %s", msgs)
	}
	first := spawns()[0]
	if !slices.Equal(first.sent(), []string{"check the fleet"}) || slices.Contains(first.args, "--resume") ||
		!hasArg(first.args, "--model", "claude-opus-5-5") || !hasArg(first.args, "--effort", "medium") ||
		!hasArg(first.args, "--tools", "Task,WebSearch") || !hasArg(first.args, "--allowedTools", strings.Join(append(aiMCPTools(), "Task", "WebSearch"), ",")) || !hasArg(first.args, "--permission-mode", "dontAsk") ||
		!hasArg(first.args, "--input-format", "stream-json") || !slices.Contains(first.args, "--include-partial-messages") {
		t.Errorf("first spawn = %v %v", first.sent(), first.args)
	}
	if !slices.Contains(first.env, "CLAUDE_CODE_OAUTH_TOKEN=oat-test") || !slices.Contains(first.env, "MCP_TOOL_TIMEOUT=2100000") {
		t.Errorf("env = %v", first.env)
	}
	if f.h.liveRun(conv.ID) == nil {
		t.Fatal("process not tracked between turns")
	}
	if session := cliSession(t, first.args); session != nil {
		_, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "gameplane_api", Arguments: map[string]any{"method": "GET", "path": "/fleet/servers"}})
		_ = session.Close()
		if err == nil || !strings.Contains(err.Error(), "this assistant run has ended") {
			t.Errorf("tool call between turns = %v", err)
		}
	}
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/messages", "", map[string]string{"prompt": "and now?"}); rr.Code != http.StatusOK {
		t.Fatalf("post = %d %s", rr.Code, rr.Body.String())
	}
	got = f.wait(conv.ID, aiIdle)
	if all := spawns(); len(all) != 1 || !slices.Equal(all[0].sent(), []string{"check the fleet", "and now?"}) || got.InputTokens != 30 {
		t.Errorf("second turn: spawns=%d sent=%v usage=%d", len(all), all[0].sent(), got.InputTokens)
	}
	if _, msgs, _ := f.detail(conv.ID, ""); len(msgs) != 4 || !strings.Contains(string(msgs[3]), "Still good.") {
		t.Errorf("messages = %s", msgs)
	}
}

func TestAICLIProcessRestart(t *testing.T) {
	f, spawns := newCLIFixture(t, func(call *aiSpawn, emit func(string)) { cliTurns(emit, call.in) })
	conv := f.create(map[string]any{"prompt": "hi"})
	f.wait(conv.ID, aiIdle)
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/messages", "", map[string]string{"prompt": "again", "model": "claude-sonnet-5-5"}); rr.Code != http.StatusOK {
		t.Fatalf("post = %d %s", rr.Code, rr.Body.String())
	}
	f.wait(conv.ID, aiIdle)
	all := spawns()
	if len(all) != 2 || !hasArg(all[1].args, "--resume", "sess-1") || !hasArg(all[1].args, "--model", "claude-sonnet-5-5") ||
		!slices.Equal(all[0].sent(), []string{"hi"}) || !slices.Equal(all[1].sent(), []string{"again"}) {
		t.Fatalf("spawns = %d", len(all))
	}
	if _, open := <-all[0].in; open {
		t.Error("first process still has stdin open")
	}
	f.h.mu.Lock()
	f.h.idle = 20 * time.Millisecond
	f.h.mu.Unlock()
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/messages", "", map[string]string{"prompt": "third"}); rr.Code != http.StatusOK {
		t.Fatalf("post = %d %s", rr.Code, rr.Body.String())
	}
	f.wait(conv.ID, aiIdle)
	waitUntracked(t, f.h, conv.ID)
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/messages", "", map[string]string{"prompt": "fourth"}); rr.Code != http.StatusOK {
		t.Fatalf("post = %d %s", rr.Code, rr.Body.String())
	}
	f.wait(conv.ID, aiIdle)
	if all := spawns(); len(all) != 3 || !hasArg(all[2].args, "--resume", "sess-1") || !slices.Equal(all[1].sent(), []string{"again", "third"}) || !slices.Equal(all[2].sent(), []string{"fourth"}) {
		t.Errorf("spawns after idle = %d", len(all))
	}
}

func TestAICLIProcessCap(t *testing.T) {
	f, spawns := newCLIFixture(t, func(call *aiSpawn, emit func(string)) { cliTurns(emit, call.in) })
	var convs []aiConversation
	for i := range aiCLIMax + 1 {
		conv := f.create(map[string]any{"prompt": "hi " + strconv.Itoa(i)})
		f.wait(conv.ID, aiIdle)
		convs = append(convs, conv)
	}
	f.h.mu.Lock()
	resident := len(f.h.procs)
	f.h.mu.Unlock()
	if resident != aiCLIMax || len(spawns()) != aiCLIMax+1 || f.h.liveRun(convs[0].ID) != nil || f.h.liveRun(convs[aiCLIMax].ID) == nil {
		t.Errorf("resident = %d, first tracked = %v", resident, f.h.liveRun(convs[0].ID) != nil)
	}
	if _, open := <-spawns()[0].in; open {
		t.Error("evicted process still has stdin open")
	}
}

func TestAICLIProcessCapBusy(t *testing.T) {
	f, spawns := newCLIFixture(t, func(call *aiSpawn, emit func(string)) {
		emit(cliInit)
		<-call.in
		<-call.in
	})
	var convs []aiConversation
	for i := range aiCLIMax {
		convs = append(convs, f.create(map[string]any{"prompt": "hi " + strconv.Itoa(i)}))
	}
	t.Cleanup(func() {
		for _, conv := range convs {
			f.h.stop(conv.ID)
		}
	})
	for deadline := time.Now().Add(5 * time.Second); len(spawns()) < aiCLIMax && time.Now().Before(deadline); {
		time.Sleep(5 * time.Millisecond)
	}
	conv := f.create(map[string]any{"prompt": "one too many"})
	if got := f.wait(conv.ID, aiFailed); got.Error != "10 assistant conversations are already running. Try again when one finishes." || len(spawns()) != aiCLIMax {
		t.Errorf("error = %q, spawns = %d", got.Error, len(spawns()))
	}
}

func waitWarm(t *testing.T, h *aiHandler, key string, spawns func() []*aiSpawn, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		h.mu.Lock()
		proc := h.procs[key]
		ready := proc != nil && !proc.busy
		h.mu.Unlock()
		if ready && len(spawns()) == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("no warm process for %s, spawns = %d", key, len(spawns()))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestAICLIWarm(t *testing.T) {
	f, spawns := newCLIFixture(t, func(call *aiSpawn, emit func(string)) { cliTurns(emit, call.in) })
	scope := map[string]any{"server": "lobby", "namespace": "games"}
	if rr := f.do(http.MethodPost, "/ai/warm", "", scope); rr.Code != http.StatusNoContent {
		t.Fatalf("warm = %d %s", rr.Code, rr.Body.String())
	}
	waitWarm(t, f.h, aiNewChat(1), spawns, 1)
	if session := cliSession(t, spawns()[0].args); session != nil {
		_, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "gameplane_api", Arguments: map[string]any{"method": "GET", "path": "/fleet/servers"}})
		_ = session.Close()
		if err == nil || !strings.Contains(err.Error(), "this assistant run has ended") {
			t.Errorf("tool call before a message = %v", err)
		}
	}
	conv := f.create(map[string]any{"prompt": "hi", "server": "lobby", "namespace": "games"})
	f.wait(conv.ID, aiIdle)
	f.h.mu.Lock()
	_, left := f.h.procs[aiNewChat(1)]
	f.h.mu.Unlock()
	if all := spawns(); len(all) != 1 || !slices.Equal(all[0].sent(), []string{"hi"}) || left || f.h.liveRun(aiNewChat(1)) != nil {
		t.Fatalf("adopt: spawns = %d, new-chat slot left = %v", len(all), left)
	}
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/warm", "", map[string]string{"model": "claude-sonnet-5-5", "effort": "high"}); rr.Code != http.StatusNoContent {
		t.Fatalf("warm conversation = %d %s", rr.Code, rr.Body.String())
	}
	waitWarm(t, f.h, conv.ID, spawns, 2)
	if args := spawns()[1].args; !hasArg(args, "--resume", "sess-1") || !hasArg(args, "--model", "claude-sonnet-5-5") {
		t.Errorf("rewarm args = %v", args)
	}
	sonnet := conv
	sonnet.Model, sonnet.Effort = "claude-sonnet-5-5", "high"
	f.h.warmCLI(t.Context(), sonnet, aiCreds{}, "oat-test")
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/messages", "", map[string]string{"prompt": "again", "model": "claude-sonnet-5-5", "effort": "high"}); rr.Code != http.StatusOK {
		t.Fatalf("post = %d %s", rr.Code, rr.Body.String())
	}
	f.wait(conv.ID, aiIdle)
	if all := spawns(); len(all) != 2 || !slices.Equal(all[1].sent(), []string{"again"}) {
		t.Errorf("after warm: spawns = %d", len(all))
	}
	if rr := f.do(http.MethodPost, "/ai/warm", "", map[string]string{"mode": "nope"}); rr.Code != http.StatusBadRequest {
		t.Errorf("bad mode = %d", rr.Code)
	}
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/warm", "bob", map[string]string{}); rr.Code != http.StatusNotFound {
		t.Errorf("other user = %d", rr.Code)
	}
}

func TestAICLIWarmBusy(t *testing.T) {
	proceed := make(chan struct{})
	f, spawns := newCLIFixture(t, func(call *aiSpawn, emit func(string)) {
		emit(cliInit)
		<-call.in
		<-proceed
		emit(cliDone)
		for range call.in {
			emit(cliDone)
		}
	})
	conv := f.create(map[string]any{"prompt": "hi"})
	deadline := time.Now().Add(5 * time.Second)
	for len(spawns()) == 0 || len(spawns()[0].sent()) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("prompt never sent")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/warm", "", map[string]string{"model": "claude-sonnet-5-5", "effort": "high"}); rr.Code != http.StatusNoContent {
		t.Fatalf("warm = %d %s", rr.Code, rr.Body.String())
	}
	sonnet := conv
	sonnet.Model, sonnet.Effort = "claude-sonnet-5-5", "high"
	f.h.warmCLI(t.Context(), sonnet, aiCreds{}, "oat-test")
	close(proceed)
	f.wait(conv.ID, aiIdle)
	if all := spawns(); len(all) != 1 {
		t.Errorf("warm replaced a busy process: spawns = %d", len(all))
	}
}

func TestAICLIFailures(t *testing.T) {
	cases := map[string]struct {
		lines []string
		want  string
	}{
		"no result":  {[]string{cliInit}, "Claude Code stopped without a result."},
		"max turns":  {[]string{cliInit, `{"type":"result","subtype":"error_max_turns","is_error":true}`}, "Stopped after 40 model calls. Send a message to continue."},
		"auth error": {[]string{`{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}`}, "Claude Code: Invalid API key · Please run /login"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			f, _ := newCLIFixture(t, func(_ *aiSpawn, emit func(string)) {
				for _, line := range tc.lines {
					emit(line)
				}
			})
			conv := f.create(map[string]any{"prompt": "hi"})
			if got := f.wait(conv.ID, aiFailed); got.Error != tc.want {
				t.Errorf("error = %q", got.Error)
			}
		})
	}
	t.Run("spawn error", func(t *testing.T) {
		f, _ := newCLIFixture(t, nil)
		f.h.spawn = func(context.Context, []string, ...string) (io.WriteCloser, io.ReadCloser, func() error, error) {
			return nil, nil, nil, errors.New("exec: not found")
		}
		conv := f.create(map[string]any{"prompt": "hi"})
		if got := f.wait(conv.ID, aiFailed); got.Error != "Claude Code could not be started." {
			t.Errorf("error = %q", got.Error)
		}
	})
}

func TestAICLITool(t *testing.T) {
	var mu sync.Mutex
	var result string
	f, _ := newCLIFixture(t, func(call *aiSpawn, emit func(string)) {
		emit(cliInit)
		emit(cliToolUse("tu1", `{"method":"GET","path":"/servers/lobby/status"}`))
		text := cliTool(t, call.args, map[string]any{"method": "GET", "path": "/servers/lobby/status"})
		mu.Lock()
		result = text
		mu.Unlock()
		emit(cliToolResult("tu1", text))
		emit(cliAssistant(`{"type":"text","text":"Running."}`))
		emit(cliDone)
	})
	f.routes["GET /servers/lobby/status"] = func() (int, string) { return http.StatusOK, `{"phase":"Running"}` }
	conv := f.create(map[string]any{"prompt": "status?", "server": "lobby", "namespace": "games"})
	f.wait(conv.ID, aiIdle)
	mu.Lock()
	got := result
	mu.Unlock()
	if got != "HTTP 200\n{\"phase\":\"Running\"}" {
		t.Errorf("tool result = %q", got)
	}
	_, msgs, _ := f.detail(conv.ID, "")
	if len(msgs) != 4 || !strings.Contains(string(msgs[1]), `"name":"gameplane_api"`) || strings.Contains(string(msgs[1]), aiMCPTool) {
		t.Errorf("messages = %s", msgs)
	}
	f.mu.Lock()
	calls := slices.Clone(f.calls)
	f.mu.Unlock()
	if !slices.ContainsFunc(calls, func(c aiCall) bool {
		return c.target == "/servers/lobby/status?cluster=local&namespace=games" && c.cookie == "gameplane_session=s1"
	}) {
		t.Errorf("calls = %+v", calls)
	}
	f.h.mcpOnce.Do(func() {})
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, f.h.mcpURL, strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("no token = %d", resp.StatusCode)
	}
}

func TestAICLIApproval(t *testing.T) {
	for _, approve := range []bool{true, false} {
		t.Run(strconv.FormatBool(approve), func(t *testing.T) {
			var mu sync.Mutex
			var result string
			f, _ := newCLIFixture(t, func(call *aiSpawn, emit func(string)) {
				emit(cliInit)
				emit(cliToolUse("tu1", `{"method":"DELETE","path":"/servers/lobby/files/delete","query":{"path":"/old.txt"}}`))
				emit(cliBarrier)
				text := cliTool(t, call.args, map[string]any{"method": "DELETE", "path": "/servers/lobby/files/delete", "query": map[string]string{"path": "/old.txt"}})
				mu.Lock()
				result = text
				mu.Unlock()
				emit(cliToolResult("tu1", text))
				emit(cliDone)
			})
			f.routes["DELETE /servers/lobby/files/delete"] = func() (int, string) { return http.StatusOK, `{}` }
			conv := f.create(map[string]any{"prompt": "delete old.txt", "server": "lobby", "namespace": "games"})
			f.wait(conv.ID, aiAwaiting)
			if _, _, pending := f.detail(conv.ID, ""); len(pending) != 1 || pending[0]["id"] != "tu1" || pending[0]["method"] != http.MethodDelete || pending[0]["path"] != "/servers/lobby/files/delete" {
				t.Fatalf("pending = %v", pending)
			}
			if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/approval", "", map[string]bool{"approve": approve}); rr.Code != http.StatusOK {
				t.Fatalf("approval = %d %s", rr.Code, rr.Body.String())
			}
			f.wait(conv.ID, aiIdle)
			mu.Lock()
			got := result
			mu.Unlock()
			f.mu.Lock()
			deleted := slices.ContainsFunc(f.calls, func(c aiCall) bool { return c.method == http.MethodDelete })
			f.mu.Unlock()
			if approve != deleted || approve != strings.HasPrefix(got, "HTTP 200") || (!approve && got != "The user declined this action.") {
				t.Errorf("approve=%v deleted=%v result=%q", approve, deleted, got)
			}
			if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/approval", "", map[string]bool{"approve": true}); rr.Code != http.StatusConflict {
				t.Errorf("second approval = %d", rr.Code)
			}
		})
	}
}

func TestAICLIConcurrentApprovals(t *testing.T) {
	calls := []string{"/a.txt", "/b.txt"}
	results := make(chan string, len(calls))
	f, _ := newCLIFixture(t, func(call *aiSpawn, emit func(string)) {
		emit(cliInit)
		var wg sync.WaitGroup
		for _, file := range calls {
			wg.Go(func() {
				results <- cliTool(t, call.args, map[string]any{"method": "DELETE", "path": "/servers/lobby/files/delete", "query": map[string]string{"path": file}})
			})
		}
		wg.Wait()
		emit(cliDone)
	})
	f.routes["DELETE /servers/lobby/files/delete"] = func() (int, string) { return http.StatusOK, `{}` }
	conv := f.create(map[string]any{"prompt": "delete both", "server": "lobby", "namespace": "games"})
	for range calls {
		f.wait(conv.ID, aiAwaiting)
		if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/approval", "", map[string]bool{"approve": true}); rr.Code != http.StatusOK {
			t.Fatalf("approval = %d %s", rr.Code, rr.Body.String())
		}
	}
	f.wait(conv.ID, aiIdle)
	for range calls {
		if got := <-results; !strings.HasPrefix(got, "HTTP 200") {
			t.Errorf("result = %q", got)
		}
	}
}

func TestAICLICancel(t *testing.T) {
	result := make(chan string, 1)
	f, _ := newCLIFixture(t, func(call *aiSpawn, emit func(string)) {
		emit(cliInit)
		result <- cliTool(t, call.args, map[string]any{"method": "DELETE", "path": "/servers/lobby/files/delete", "query": map[string]string{"path": "/x"}})
		emit(cliDone)
	})
	conv := f.create(map[string]any{"prompt": "delete x", "server": "lobby", "namespace": "games"})
	f.wait(conv.ID, aiAwaiting)
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/cancel", "", nil); rr.Code != http.StatusNoContent {
		t.Fatalf("cancel = %d %s", rr.Code, rr.Body.String())
	}
	if got := f.wait(conv.ID, aiIdle); got.Error != "Stopped by the user." {
		t.Errorf("error = %q", got.Error)
	}
	waitUntracked(t, f.h, conv.ID)
	var got string
	select {
	case got = <-result:
	case <-time.After(5 * time.Second):
		t.Fatal("tool result never arrived")
	}
	f.mu.Lock()
	deleted := slices.ContainsFunc(f.calls, func(c aiCall) bool { return c.method == http.MethodDelete })
	f.mu.Unlock()
	if got != "The user declined this action." || deleted {
		t.Errorf("result=%q deleted=%v", got, deleted)
	}
}

func TestAICLIApprovalKeepsStreaming(t *testing.T) {
	awaiting, emitted := make(chan struct{}), make(chan struct{})
	f, _ := newCLIFixture(t, func(call *aiSpawn, emit func(string)) {
		emit(cliInit)
		emit(cliToolUse("tu1", `{"method":"DELETE","path":"/servers/lobby/files/delete","query":{"path":"/a.jar"}}`))
		emit(cliBarrier)
		result := make(chan string, 1)
		go func() {
			result <- cliTool(t, call.args, map[string]any{"method": "DELETE", "path": "/servers/lobby/files/delete", "query": map[string]string{"path": "/a.jar"}})
		}()
		<-awaiting
		emit(cliToolUse("tu2", `{"method":"DELETE","path":"/servers/lobby/files/delete","query":{"path":"/b.jar"}}`))
		emit(cliBarrier)
		close(emitted)
		emit(cliToolResult("tu1", <-result))
		emit(cliDone)
	})
	f.routes["DELETE /servers/lobby/files/delete"] = func() (int, string) { return http.StatusOK, `{}` }
	conv := f.create(map[string]any{"prompt": "delete a and b", "server": "lobby", "namespace": "games"})
	f.wait(conv.ID, aiAwaiting)
	close(awaiting)
	<-emitted
	got, msgs, pending := f.detail(conv.ID, "")
	if got.Status != aiAwaiting || len(msgs) != 3 || len(pending) != 1 || pending[0]["id"] != "tu1" {
		t.Fatalf("status=%s messages=%d pending=%v", got.Status, len(msgs), pending)
	}
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/approval", "", map[string]bool{"approve": true}); rr.Code != http.StatusOK {
		t.Fatalf("approval = %d %s", rr.Code, rr.Body.String())
	}
	f.wait(conv.ID, aiIdle)
}

func TestAICLIRestartResetsWaiting(t *testing.T) {
	f, _ := newCLIFixture(t, func(_ *aiSpawn, emit func(string)) {
		emit(cliInit)
		emit(cliDone)
	})
	conv := f.create(map[string]any{"prompt": "hi"})
	f.wait(conv.ID, aiIdle)
	if _, err := f.h.store.DB.ExecContext(t.Context(), `UPDATE ai_conversations SET status = ? WHERE id = ?`, aiAwaiting, conv.ID); err != nil {
		t.Fatal(err)
	}
	f.h.mount(chi.NewRouter())
	if got := f.wait(conv.ID, aiFailed); got.Error != "Interrupted by an API restart." {
		t.Errorf("restart reset = %q", got.Error)
	}
}

func TestAIPendingID(t *testing.T) {
	use := json.RawMessage(`{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"gameplane_api","input":{"method":"DELETE","path":"/backups/b1"}}]}`)
	done := json.RawMessage(`{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"ok"}]}`)
	in := aiToolInput{Method: "delete", Path: "/backups/b1"}
	if got := aiPendingID([]json.RawMessage{use}, in); got != "tu1" {
		t.Errorf("open = %q", got)
	}
	if got := aiPendingID([]json.RawMessage{use, done}, in); got != "" {
		t.Errorf("resolved = %q", got)
	}
	if got := aiPendingID([]json.RawMessage{json.RawMessage(`"text"`), use}, aiToolInput{Method: "GET", Path: "/backups"}); got != "" {
		t.Errorf("other = %q", got)
	}
}

func TestAISecretSubscription(t *testing.T) {
	k := &kube.Client{Typed: kubefake.NewClientset()}
	f := newAIFixture(t, true)
	MountAISecret(f.r, k, notifNS)
	key := AIKeyReader(k, notifNS)
	if rr := f.do(http.MethodPut, "/admin/ai/secret", "", map[string]string{"apiKey": "sk", "oauthToken": "oat"}); rr.Code != http.StatusUnprocessableEntity {
		t.Errorf("both = %d", rr.Code)
	}
	if rr := f.do(http.MethodPut, "/admin/ai/secret", "", map[string]string{"oauthToken": "oat-live"}); rr.Code != http.StatusOK || strings.Contains(rr.Body.String(), "oat-live") {
		t.Fatalf("put token = %d %s", rr.Code, rr.Body.String())
	}
	syncSecretData(t, k, notifNS, aiSecretName)
	if got, sub := key(t.Context()); got != "oat-live" || !sub {
		t.Errorf("token = %q %v", got, sub)
	}
	if rr := f.do(http.MethodPut, "/admin/ai/secret", "", map[string]string{"apiKey": "sk-live"}); rr.Code != http.StatusOK {
		t.Fatalf("put key = %d %s", rr.Code, rr.Body.String())
	}
	syncSecretData(t, k, notifNS, aiSecretName)
	if got, sub := key(t.Context()); got != "sk-live" || sub {
		t.Errorf("key = %q %v", got, sub)
	}
}

func TestAICLIAdminShell(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
	conv := aiConversation{Model: "claude-opus-5-5", Effort: "medium"}
	user := aiCLIArgs(conv, "http://127.0.0.1:1/mcp", "tok", false)
	if !hasArg(user, "--tools", "Task,WebSearch") || !hasArg(user, "--allowedTools", strings.Join(append(aiMCPTools(), "Task", "WebSearch"), ",")) || strings.Contains(user[slices.Index(user, "--system-prompt")+1], "kubectl") {
		t.Errorf("user args = %v", user)
	}
	admin := aiCLIArgs(conv, "http://127.0.0.1:1/mcp", "tok", true)
	if !hasArg(admin, "--tools", "Task,WebSearch,Bash,Monitor,TaskStop") || !hasArg(admin, "--allowedTools", strings.Join(append(aiMCPTools(), "Task", "WebSearch", "Bash", "Monitor", "TaskStop"), ",")) || !strings.Contains(admin[slices.Index(admin, "--system-prompt")+1], "kubectl") {
		t.Errorf("admin args = %v", admin)
	}
	if env := aiCLIEnv("oat", false); slices.Contains(env, "SHELL=/bin/bash") {
		t.Errorf("user env = %v", env)
	}
	if env := aiCLIEnv("oat", true); !slices.Contains(env, "SHELL=/bin/bash") || !slices.Contains(env, "KUBERNETES_SERVICE_HOST=10.0.0.1") {
		t.Errorf("admin env = %v", env)
	}
	adminReq := httptest.NewRequestWithContext(auth.WithUser(t.Context(), &auth.User{Role: rbac.RoleAdmin}), http.MethodPost, "/ai/conversations", nil)
	userReq := httptest.NewRequestWithContext(auth.WithUser(t.Context(), &auth.User{Role: "viewer"}), http.MethodPost, "/ai/conversations", nil)
	if !aiCredentials(adminReq).admin || aiCredentials(userReq).admin {
		t.Error("admin flag follows the built-in admin role")
	}
}

func TestAICLIModes(t *testing.T) {
	for mode, want := range map[string]string{"": "dontAsk", aiModeDefault: "dontAsk", aiModeAuto: "auto", aiModeBypass: "bypassPermissions", aiModePlan: "dontAsk"} {
		args := aiCLIArgs(aiConversation{Model: "claude-opus-5-5", Effort: "medium", Mode: mode}, "http://127.0.0.1:1/mcp", "tok", true)
		system := args[slices.Index(args, "--system-prompt")+1]
		if !hasArg(args, "--permission-mode", want) || strings.Contains(system, "Bypass permissions is on") != (mode == aiModeBypass) {
			t.Errorf("mode %q args = %v", mode, args)
		}
	}
}

func TestAICLIBypass(t *testing.T) {
	var mu sync.Mutex
	var result string
	f, spawns := newCLIFixture(t, func(call *aiSpawn, emit func(string)) {
		emit(cliInit)
		emit(cliToolUse("tu1", `{"method":"DELETE","path":"/servers/lobby/files/delete","query":{"path":"/old.txt"}}`))
		emit(cliBarrier)
		text := cliTool(t, call.args, map[string]any{"method": "DELETE", "path": "/servers/lobby/files/delete", "query": map[string]string{"path": "/old.txt"}})
		mu.Lock()
		result = text
		mu.Unlock()
		emit(cliToolResult("tu1", text))
		emit(cliDone)
	})
	f.routes["DELETE /servers/lobby/files/delete"] = func() (int, string) { return http.StatusOK, `{}` }
	conv := f.create(map[string]any{"prompt": "delete old.txt", "server": "lobby", "namespace": "games", "mode": aiModeBypass})
	f.wait(conv.ID, aiIdle)
	mu.Lock()
	got := result
	mu.Unlock()
	if args := spawns()[0].args; !strings.HasPrefix(got, "HTTP 200") || !hasArg(args, "--permission-mode", "bypassPermissions") {
		t.Errorf("result = %q args = %v", got, args)
	}
}
