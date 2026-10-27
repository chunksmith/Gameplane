package handlers

import (
	"bufio"
	"cmp"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	aiClaudeBin    = "/usr/local/bin/claude"
	aiClaudeHome   = "/data/claude"
	aiMCPPrefix    = "mcp__gameplane__"
	aiMCPTool      = aiMCPPrefix + "gameplane_api"
	aiApprovalWait = 30 * time.Minute
	aiCLIIdle      = 10 * time.Minute
	aiCLIGrace     = 5 * time.Second
	aiCLIMax       = 10
)

var errAICLIFull = errors.New("claude process limit reached")

const aiShellPrompt = `

Shell (admins only): you also have a Bash tool with kubectl, curl and wget. It runs inside the Gameplane API container, and kubectl uses the API's Kubernetes service account in this cluster. Use it for what the API cannot do: cluster and node inspection, pod logs, kubectl exec into game containers, and resources outside Gameplane. Change GameServers, backups and schedules through gameplane_api: the operator owns the StatefulSets, Services and PVCs it creates and reverts direct edits. In a server conversation, stay on that server unless the user asks for more. A kubectl Forbidden error means the service account lacks that permission: say so instead of working around it.`

func aiShellText(mode string) string {
	switch mode {
	case aiModeBypass:
		return aiShellPrompt + " Bypass permissions is on: run the commands the task needs without asking the user to confirm."
	case aiModeAuto:
		return aiShellPrompt + " Auto mode checks each shell command and blocks risky ones; when a command is blocked, tell the user instead of working around it."
	}
	return aiShellPrompt + " Shell commands run without approval, so ask the user before anything destructive."
}

func aiCLIMode(mode string) string {
	if mode == aiModeAuto || mode == aiModeBypass {
		return mode
	}
	return "dontAsk"
}

type aiLive struct {
	conv   aiConversation
	creds  aiCreds
	linear *aiLinear
	runID  string
	proc   *aiProc
	done   <-chan struct{}
	cancel context.CancelFunc

	mu      sync.Mutex
	waiting *aiToolInput
	decide  chan bool
}

func (run *aiLive) ended() bool {
	select {
	case <-run.done:
		return true
	default:
		return false
	}
}

type aiProc struct {
	id     string
	token  string
	spec   string
	stdin  io.WriteCloser
	scan   *bufio.Scanner
	kill   context.CancelFunc
	exited chan struct{}
	busy   bool
	last   time.Time
	timer  *time.Timer
}

func (p *aiProc) alive() bool {
	select {
	case <-p.exited:
		return false
	default:
		return true
	}
}

func (p *aiProc) send(content []anthropic.BetaContentBlockParamUnion) error {
	var message any = content
	if len(content) == 1 && content[0].OfText != nil {
		message = content[0].OfText.Text
	}
	line, err := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": message}, "parent_tool_use_id": nil})
	if err != nil {
		return fmt.Errorf("encode prompt: %w", err)
	}
	if _, err := p.stdin.Write(append(line, '\n')); err != nil {
		return fmt.Errorf("send prompt: %w", err)
	}
	return nil
}

func (p *aiProc) stop(graceful bool) {
	if !graceful {
		p.kill()
	}
	_ = p.stdin.Close()
	select {
	case <-p.exited:
	case <-time.After(aiCLIGrace):
		p.kill()
		<-p.exited
	}
}

type aiEvent struct {
	Type      string              `json:"type"`
	Subtype   string              `json:"subtype"`
	SessionID string              `json:"session_id"`
	Message   json.RawMessage     `json:"message"`
	Event     json.RawMessage     `json:"event"`
	IsError   bool                `json:"is_error"`
	Result    string              `json:"result"`
	Usage     anthropic.BetaUsage `json:"usage"`
}

func (h *aiHandler) begin(ctx context.Context, conv aiConversation, creds aiCreds, key string, sub bool, runID string, content []anthropic.BetaContentBlockParamUnion) {
	if sub {
		go h.runCLI(ctx, conv, creds, key, runID, content)
		return
	}
	go h.run(ctx, conv, creds, key, runID, nil)
}

func (h *aiHandler) runCLI(ctx context.Context, conv aiConversation, creds aiCreds, token, runID string, content []anthropic.BetaContentBlockParamUnion) {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer h.pushFlush(conv.ID)
	h.mcpOnce.Do(func() { h.startMCP(runCtx) })
	if h.mcpURL == "" {
		h.settle(ctx, conv.ID, runID, aiFailed, "The assistant tool endpoint could not start.")
		return
	}
	linear := h.openLinear(runCtx, conv.UserID)
	defer linear.close()
	run := &aiLive{conv: conv, creds: creds, linear: linear, runID: runID, done: runCtx.Done(), cancel: cancel}
	err := h.attach(ctx, run, token, content)
	if errors.Is(err, errAICLIFull) {
		h.settle(ctx, conv.ID, runID, aiFailed, fmt.Sprintf("%d assistant conversations are already running. Try again when one finishes.", aiCLIMax))
		return
	}
	if err != nil {
		slog.Warn("start claude", "err", err)
		h.settle(ctx, conv.ID, runID, aiFailed, "Claude Code could not be started.")
		return
	}
	last, err := h.stream(ctx, conv, runID, run.proc.scan)
	if err == nil && last.Type == "result" {
		h.release(run.proc)
	} else {
		cancel()
		h.drop(run.proc, false)
	}
	switch {
	case errors.Is(err, errAIStopped):
		return
	case err != nil:
		slog.Warn("record claude output", "id", conv.ID, "err", err)
		h.settle(ctx, conv.ID, runID, aiFailed, "Could not save the conversation.")
	case last.Type != "result":
		h.settle(ctx, conv.ID, runID, aiFailed, "Claude Code stopped without a result.")
	case last.Subtype == "error_max_turns":
		h.settle(ctx, conv.ID, runID, aiFailed, fmt.Sprintf("Stopped after %d model calls. Send a message to continue.", aiMaxSteps))
	case last.IsError:
		h.settle(ctx, conv.ID, runID, aiFailed, "Claude Code: "+aiClip(cmp.Or(last.Result, last.Subtype), 300))
	default:
		h.settle(ctx, conv.ID, runID, aiIdle, "")
	}
}

func (h *aiHandler) attach(ctx context.Context, run *aiLive, token string, content []anthropic.BetaContentBlockParamUnion) error {
	names := run.linear.names()
	for retry := range 2 {
		proc, fresh, err := h.process(ctx, run.conv, token, run.creds.admin, names, false)
		if err != nil {
			return err
		}
		run.proc = proc
		h.track(run)
		err = proc.send(content)
		if err == nil || fresh || retry > 0 {
			return err
		}
		h.drop(proc, false)
	}
	return nil
}

func (h *aiHandler) stream(ctx context.Context, conv aiConversation, runID string, scanner *bufio.Scanner) (aiEvent, error) {
	var last aiEvent
	for scanner.Scan() {
		var ev aiEvent
		if json.Unmarshal(scanner.Bytes(), &ev) != nil {
			continue
		}
		last = ev
		switch ev.Type {
		case "system":
			if ev.Subtype != "init" || ev.SessionID == "" || ev.SessionID == conv.SessionID {
				continue
			}
			conv.SessionID = ev.SessionID
			if _, err := h.store.DB.ExecContext(ctx, `UPDATE ai_conversations SET session_id = ? WHERE id = ?`, ev.SessionID, conv.ID); err != nil {
				return last, fmt.Errorf("save ai session: %w", err)
			}
		case "assistant", "user":
			if msg, ok := aiCLIMessage(ev.Type, ev.Message); ok {
				if err := h.appendRaw(ctx, conv.ID, runID, msg); err != nil {
					return last, err
				}
			}
		case "stream_event":
			h.pushText(conv.ID, aiCLIDelta(ev.Event))
		case "result":
			h.addUsage(ctx, conv.ID, ev.Usage)
			return last, nil
		}
	}
	if err := scanner.Err(); err != nil {
		return last, fmt.Errorf("read claude output: %w", err)
	}
	return last, nil
}

func aiCLIMessage(role string, raw json.RawMessage) ([]byte, bool) {
	var msg struct {
		Content []map[string]json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &msg) != nil || len(msg.Content) == 0 {
		return nil, false
	}
	for _, block := range msg.Content {
		var name string
		if json.Unmarshal(block["name"], &name) == nil && strings.HasPrefix(name, aiMCPPrefix) {
			block["name"] = json.RawMessage(strconv.Quote(strings.TrimPrefix(name, aiMCPPrefix)))
		}
	}
	data, err := json.Marshal(map[string]any{"role": role, "content": msg.Content})
	return data, err == nil
}

func aiCLIDelta(raw json.RawMessage) string {
	var ev struct {
		Type  string `json:"type"`
		Delta struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
	}
	if json.Unmarshal(raw, &ev) != nil || ev.Type != "content_block_delta" || ev.Delta.Type != "text_delta" {
		return ""
	}
	return ev.Delta.Text
}

func aiCLIArgs(conv aiConversation, mcpURL, token string, admin bool, linear ...string) []string {
	servers, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"gameplane": map[string]any{
		"type": "http", "url": mcpURL, "headers": map[string]string{"Authorization": "Bearer " + token},
	}}})
	allowedTools := aiMCPTools()
	for _, name := range linear {
		allowedTools = append(allowedTools, aiMCPPrefix+name)
	}
	tools, system := "", aiSystemPrompt(conv)
	if len(linear) > 0 {
		system += aiLinearPrompt
	}
	if admin {
		tools, allowedTools, system = "Bash", append(allowedTools, "Bash"), system+aiShellText(conv.Mode)
	}
	allowed := strings.Join(allowedTools, ",")
	args := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--model", conv.Model, "--effort", conv.Effort, "--max-turns", strconv.Itoa(aiMaxSteps),
		"--system-prompt", system,
		"--strict-mcp-config", "--mcp-config", string(servers),
		"--permission-mode", aiCLIMode(conv.Mode), "--allowedTools", allowed, "--tools", tools}
	if conv.SessionID != "" {
		args = append(args, "--resume", conv.SessionID)
	}
	return args
}

func aiCLISpec(conv aiConversation, token string, admin bool, linear []string) string {
	conv.SessionID = ""
	return strings.Join(append(aiCLIEnv(token, admin), aiCLIArgs(conv, "", "", admin, linear...)...), "\x00")
}

func aiCLIEnv(token string, admin bool) []string {
	env := []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=" + aiClaudeHome,
		"CLAUDE_CONFIG_DIR=" + filepath.Join(aiClaudeHome, "config"),
		"TMPDIR=" + filepath.Join(aiClaudeHome, "tmp"),
		"CLAUDE_CODE_OAUTH_TOKEN=" + token,
		"DISABLE_UPDATES=1",
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
		"MCP_TOOL_TIMEOUT=" + strconv.FormatInt((aiApprovalWait+5*time.Minute).Milliseconds(), 10),
	}
	if admin {
		env = append(env, "SHELL=/bin/bash",
			"KUBERNETES_SERVICE_HOST="+os.Getenv("KUBERNETES_SERVICE_HOST"),
			"KUBERNETES_SERVICE_PORT="+os.Getenv("KUBERNETES_SERVICE_PORT"))
	}
	return env
}

func spawnClaude(ctx context.Context, env []string, args ...string) (io.WriteCloser, io.ReadCloser, func() error, error) {
	work := filepath.Join(aiClaudeHome, "work")
	for _, dir := range []string{work, filepath.Join(aiClaudeHome, "tmp"), filepath.Join(aiClaudeHome, "config")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, nil, nil, fmt.Errorf("create %s: %w", dir, err)
		}
	}
	var stderr strings.Builder
	cmd := exec.CommandContext(ctx, aiClaudeBin)
	cmd.Args = append(cmd.Args, args...)
	cmd.Dir, cmd.Env, cmd.Stderr = work, env, &stderr
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("claude stdin: %w", err)
	}
	out, writer, err := os.Pipe()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("claude stdout: %w", err)
	}
	cmd.Stdout = writer
	err = cmd.Start()
	_ = writer.Close()
	if err != nil {
		_ = out.Close()
		return nil, nil, nil, fmt.Errorf("start claude: %w", err)
	}
	return in, out, func() error {
		if err := cmd.Wait(); err != nil {
			return fmt.Errorf("claude: %w: %s", err, aiClip(stderr.String(), 500))
		}
		return nil
	}, nil
}

func aiNewChat(user int64) string {
	return "new:" + strconv.FormatInt(user, 10)
}

func (h *aiHandler) warmCLI(ctx context.Context, conv aiConversation, creds aiCreds, token string) {
	h.mcpOnce.Do(func() { h.startMCP(ctx) })
	if h.mcpURL == "" {
		return
	}
	linear := h.openLinear(ctx, conv.UserID)
	linear.close()
	proc, fresh, err := h.process(ctx, conv, token, creds.admin, linear.names(), true)
	if err != nil {
		slog.Warn("warm claude", "err", err)
		return
	}
	if proc == nil {
		return
	}
	if fresh {
		done, cancel := context.WithCancel(ctx)
		cancel()
		h.track(&aiLive{conv: conv, creds: creds, linear: linear, proc: proc, done: done.Done(), cancel: cancel})
	}
	h.release(proc)
}

func (h *aiHandler) adopt(from, to string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	proc := h.procs[from]
	if proc == nil {
		return
	}
	delete(h.procs, from)
	proc.id, h.procs[to] = to, proc
	if run := h.live[from]; run != nil {
		delete(h.live, from)
		run.conv.ID, h.live[to] = to, run
	}
}

func (h *aiHandler) process(ctx context.Context, conv aiConversation, token string, admin bool, linear []string, warm bool) (*aiProc, bool, error) {
	spec := aiCLISpec(conv, token, admin, linear)
	h.mu.Lock()
	proc := h.procs[conv.ID]
	if warm && proc != nil && proc.busy {
		h.mu.Unlock()
		return nil, false, nil
	}
	if proc != nil && !proc.busy && proc.spec == spec && proc.alive() {
		proc.busy = true
		proc.timer.Stop()
		h.mu.Unlock()
		return proc, false, nil
	}
	graceful := proc != nil && !proc.busy
	if proc != nil {
		h.forget(proc)
	}
	for len(h.procs) >= aiCLIMax {
		victim := h.longestIdle()
		if victim == nil {
			break
		}
		h.forget(victim)
		go victim.stop(true)
	}
	full := len(h.procs) >= aiCLIMax
	h.mu.Unlock()
	if proc != nil {
		proc.stop(graceful)
	}
	if full {
		return nil, false, errAICLIFull
	}
	proc, err := h.spawnProc(ctx, conv, token, admin, linear, spec)
	return proc, true, err
}

func (h *aiHandler) spawnProc(ctx context.Context, conv aiConversation, token string, admin bool, linear []string, spec string) (*aiProc, error) {
	ctx, kill := context.WithCancel(context.WithoutCancel(ctx))
	proc := &aiProc{id: conv.ID, token: rand.Text(), spec: spec, kill: kill, exited: make(chan struct{}), busy: true}
	stdin, stdout, wait, err := h.spawn(ctx, aiCLIEnv(token, admin), aiCLIArgs(conv, h.mcpURL, proc.token, admin, linear...)...)
	if err != nil {
		kill()
		return nil, err
	}
	proc.stdin, proc.scan = stdin, bufio.NewScanner(stdout)
	proc.scan.Buffer(make([]byte, 0, 64*1024), 16<<20)
	go func() {
		if err := wait(); err != nil {
			slog.Warn("claude exited", "id", conv.ID, "err", err)
		}
		kill()
		close(proc.exited)
	}()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.procs == nil {
		h.procs = map[string]*aiProc{}
	}
	h.procs[conv.ID] = proc
	return proc, nil
}

func (h *aiHandler) longestIdle() *aiProc {
	var oldest *aiProc
	for _, proc := range h.procs {
		if !proc.busy && (oldest == nil || proc.last.Before(oldest.last)) {
			oldest = proc
		}
	}
	return oldest
}

func (h *aiHandler) forget(proc *aiProc) {
	if h.procs[proc.id] == proc {
		delete(h.procs, proc.id)
	}
	if run := h.live[proc.id]; run != nil && run.proc == proc {
		delete(h.live, proc.id)
	}
	if proc.timer != nil {
		proc.timer.Stop()
	}
}

func (h *aiHandler) drop(proc *aiProc, graceful bool) {
	h.mu.Lock()
	h.forget(proc)
	h.mu.Unlock()
	proc.stop(graceful)
}

func (h *aiHandler) release(proc *aiProc) {
	h.mu.Lock()
	defer h.mu.Unlock()
	proc.busy, proc.last = false, time.Now()
	proc.timer = time.AfterFunc(cmp.Or(h.idle, aiCLIIdle), func() { h.expire(proc) })
}

func (h *aiHandler) expire(proc *aiProc) {
	h.mu.Lock()
	if proc.busy || h.procs[proc.id] != proc {
		h.mu.Unlock()
		return
	}
	h.forget(proc)
	h.mu.Unlock()
	proc.stop(true)
}

func (h *aiHandler) mcpServer(run *aiLive) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "gameplane", Version: "1"}, nil)
	for _, spec := range aiTools {
		server.AddTool(spec.mcp(), h.mcpCall)
	}
	if run != nil && run.linear != nil {
		for _, tool := range run.linear.tools {
			server.AddTool(&mcp.Tool{Name: aiLinearPrefix + tool.Name, Description: tool.Description, InputSchema: tool.InputSchema}, h.mcpLinearCall)
		}
	}
	return server
}

func (h *aiHandler) startMCP(ctx context.Context) {
	handler := mcp.NewStreamableHTTPHandler(func(req *http.Request) *mcp.Server {
		return h.mcpServer(h.liveByToken(req.Header.Get("Authorization")))
	}, &mcp.StreamableHTTPOptions{Stateless: true})
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		slog.Warn("start ai tool endpoint", "err", err)
		return
	}
	h.mcpURL = "http://" + ln.Addr().String() + "/mcp"
	srv := &http.Server{ReadHeaderTimeout: 10 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if h.liveByToken(req.Header.Get("Authorization")) == nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		handler.ServeHTTP(w, req)
	})}
	go func() {
		if err := srv.Serve(ln); err != nil {
			slog.Warn("ai tool endpoint stopped", "err", err)
		}
	}()
}

func (h *aiHandler) mcpCall(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var run *aiLive
	if req.Extra != nil {
		run = h.liveByToken(req.Extra.Header.Get("Authorization"))
	}
	if run == nil || run.ended() {
		return nil, errors.New("this assistant run has ended")
	}
	text, failed := h.mcpInvoke(ctx, run, req.Params.Name, req.Params.Arguments)
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}, IsError: failed}, nil
}

func (h *aiHandler) mcpInvoke(ctx context.Context, run *aiLive, name string, args json.RawMessage) (string, bool) {
	if aiIsFileTool(name) {
		return h.fileTool(ctx, run.conv, run.creds, name, args)
	}
	var in aiToolInput
	if err := json.Unmarshal(args, &in); err != nil {
		return "Invalid tool input: " + err.Error(), true
	}
	if run.conv.Mode != aiModeBypass && in.needsApproval() && !h.await(ctx, run, in) {
		return "The user declined this action.", true
	}
	status, body := h.tool(ctx, run.conv, run.creds, in)
	return fmt.Sprintf("HTTP %d\n%s", status, body), status >= http.StatusBadRequest
}

func (h *aiHandler) mcpLinearCall(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var run *aiLive
	if req.Extra != nil {
		run = h.liveByToken(req.Extra.Header.Get("Authorization"))
	}
	if run == nil || run.ended() {
		return nil, errors.New("this assistant run has ended")
	}
	use := aiToolUse{name: req.Params.Name, raw: req.Params.Arguments}
	text, failed := "The user declined this action.", true
	if run.conv.Mode == aiModeBypass || !use.needsApproval() || h.await(ctx, run, aiToolInput{Method: use.method(), Path: use.target()}) {
		text, failed = run.linear.call(ctx, use.name, use.raw)
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}, IsError: failed}, nil
}

func (h *aiHandler) await(ctx context.Context, run *aiLive, in aiToolInput) bool {
	decide := make(chan bool, 1)
	run.mu.Lock()
	run.waiting, run.decide = &in, decide
	run.mu.Unlock()
	defer func() {
		run.mu.Lock()
		run.waiting, run.decide = nil, nil
		run.mu.Unlock()
	}()
	if !h.flip(ctx, run.conv.ID, run.runID, aiRunning, aiAwaiting) {
		return false
	}
	timer := time.NewTimer(aiApprovalWait)
	defer timer.Stop()
	select {
	case approved := <-decide:
		return approved
	case <-ctx.Done():
	case <-run.done:
	case <-timer.C:
	}
	h.flip(context.WithoutCancel(ctx), run.conv.ID, run.runID, aiAwaiting, aiRunning)
	return false
}

func (h *aiHandler) decide(ctx context.Context, id string, approve bool) bool {
	run := h.liveRun(id)
	if run == nil {
		return false
	}
	run.mu.Lock()
	defer run.mu.Unlock()
	if run.decide == nil || !h.flip(ctx, id, run.runID, aiAwaiting, aiRunning) {
		return false
	}
	run.decide <- approve
	run.decide = nil
	return true
}

func (h *aiHandler) waitingInput(id string) *aiToolInput {
	run := h.liveRun(id)
	if run == nil {
		return nil
	}
	run.mu.Lock()
	defer run.mu.Unlock()
	return run.waiting
}

func (h *aiHandler) stop(id string) {
	if run := h.liveRun(id); run != nil {
		run.cancel()
		run.proc.kill()
	}
}

func (h *aiHandler) flip(ctx context.Context, id, runID, from, to string) bool {
	res, err := h.store.DB.ExecContext(ctx, `UPDATE ai_conversations SET status = ?, updated_at = ? WHERE id = ? AND run_id = ? AND status = ?`, to, aiNow(), id, runID, from)
	if err != nil {
		return false
	}
	n, err := res.RowsAffected()
	return err == nil && n == 1
}

func (h *aiHandler) track(run *aiLive) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.live == nil {
		h.live = map[string]*aiLive{}
	}
	h.live[run.conv.ID] = run
}

func (h *aiHandler) liveRun(id string) *aiLive {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.live[id]
}

func (h *aiHandler) liveByToken(header string) *aiLive {
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok || token == "" {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, run := range h.live {
		if subtle.ConstantTimeCompare([]byte(run.proc.token), []byte(token)) == 1 {
			return run
		}
	}
	return nil
}

func aiPendingID(msgs []json.RawMessage, in aiToolInput) string {
	id, resolved := "", map[string]bool{}
	for _, raw := range msgs {
		var msg struct {
			Content []struct {
				Type      string          `json:"type"`
				ID        string          `json:"id"`
				Name      string          `json:"name"`
				ToolUseID string          `json:"tool_use_id"`
				Input     json.RawMessage `json:"input"`
			} `json:"content"`
		}
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}
		for _, block := range msg.Content {
			var input aiToolInput
			linear, isLinear := strings.CutPrefix(block.Name, aiLinearPrefix)
			switch {
			case block.Type == "tool_result":
				resolved[block.ToolUseID] = true
			case block.Type != "tool_use":
			case isLinear:
				if in.Method == aiLinearMethod && in.Path == linear {
					id = block.ID
				}
			case json.Unmarshal(block.Input, &input) == nil && strings.EqualFold(input.Method, in.Method) && input.Path == in.Path && maps.Equal(input.Query, in.Query):
				id = block.ID
			}
		}
	}
	if resolved[id] {
		return ""
	}
	return id
}

func aiClip(text string, limit int) string {
	if runes := []rune(text); len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return text
}
