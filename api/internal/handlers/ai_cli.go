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
	aiMCPTool      = "mcp__gameplane__gameplane_api"
	aiApprovalWait = 30 * time.Minute
)

type aiLive struct {
	conv   aiConversation
	creds  aiCreds
	runID  string
	token  string
	done   <-chan struct{}
	cancel context.CancelFunc

	mu      sync.Mutex
	waiting *aiToolInput
	decide  chan bool
}

type aiEvent struct {
	Type      string              `json:"type"`
	Subtype   string              `json:"subtype"`
	SessionID string              `json:"session_id"`
	Message   json.RawMessage     `json:"message"`
	IsError   bool                `json:"is_error"`
	Result    string              `json:"result"`
	Usage     anthropic.BetaUsage `json:"usage"`
}

func (h *aiHandler) begin(ctx context.Context, conv aiConversation, creds aiCreds, key string, sub bool, runID, prompt string) {
	if sub {
		go h.runCLI(ctx, conv, creds, key, runID, prompt)
		return
	}
	go h.run(ctx, conv, creds, key, runID, nil)
}

func (h *aiHandler) runCLI(ctx context.Context, conv aiConversation, creds aiCreds, token, runID, prompt string) {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	h.mcpOnce.Do(func() { h.startMCP(runCtx) })
	if h.mcpURL == "" {
		h.settle(ctx, conv.ID, runID, aiFailed, "The assistant tool endpoint could not start.")
		return
	}
	run := &aiLive{conv: conv, creds: creds, runID: runID, token: rand.Text(), done: runCtx.Done(), cancel: cancel}
	h.track(run)
	defer h.untrack(run)
	out, wait, err := h.spawn(runCtx, aiCLIEnv(token), prompt, aiCLIArgs(conv, h.mcpURL, run.token)...)
	if err != nil {
		slog.Warn("start claude", "err", err)
		h.settle(ctx, conv.ID, runID, aiFailed, "Claude Code could not be started.")
		return
	}
	last, err := h.stream(ctx, conv, runID, out)
	if err != nil {
		cancel()
	}
	_ = out.Close()
	if waitErr := wait(); waitErr != nil && last.Type != "result" {
		slog.Warn("claude exited", "id", conv.ID, "err", waitErr)
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

func (h *aiHandler) stream(ctx context.Context, conv aiConversation, runID string, out io.Reader) (aiEvent, error) {
	var last aiEvent
	scanner := bufio.NewScanner(out)
	scanner.Buffer(make([]byte, 0, 64*1024), 16<<20)
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
		case "result":
			h.addUsage(ctx, conv.ID, ev.Usage)
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
		if string(block["name"]) == strconv.Quote(aiMCPTool) {
			block["name"] = json.RawMessage(strconv.Quote(aiTool.OfTool.Name))
		}
	}
	data, err := json.Marshal(map[string]any{"role": role, "content": msg.Content})
	return data, err == nil
}

func aiCLIArgs(conv aiConversation, mcpURL, token string) []string {
	servers, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"gameplane": map[string]any{
		"type": "http", "url": mcpURL, "headers": map[string]string{"Authorization": "Bearer " + token},
	}}})
	args := []string{"-p", "--output-format", "stream-json", "--verbose",
		"--model", conv.Model, "--effort", conv.Effort, "--max-turns", strconv.Itoa(aiMaxSteps),
		"--system-prompt", aiSystemPrompt(conv),
		"--strict-mcp-config", "--mcp-config", string(servers),
		"--permission-mode", "dontAsk", "--allowedTools", aiMCPTool, "--tools", ""}
	if conv.SessionID != "" {
		args = append(args, "--resume", conv.SessionID)
	}
	return args
}

func aiCLIEnv(token string) []string {
	return []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=" + aiClaudeHome,
		"CLAUDE_CONFIG_DIR=" + filepath.Join(aiClaudeHome, "config"),
		"TMPDIR=" + filepath.Join(aiClaudeHome, "tmp"),
		"CLAUDE_CODE_OAUTH_TOKEN=" + token,
		"DISABLE_UPDATES=1",
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
		"MCP_TOOL_TIMEOUT=" + strconv.FormatInt((aiApprovalWait+5*time.Minute).Milliseconds(), 10),
	}
}

func spawnClaude(ctx context.Context, env []string, stdin string, args ...string) (io.ReadCloser, func() error, error) {
	work := filepath.Join(aiClaudeHome, "work")
	for _, dir := range []string{work, filepath.Join(aiClaudeHome, "tmp"), filepath.Join(aiClaudeHome, "config")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, nil, fmt.Errorf("create %s: %w", dir, err)
		}
	}
	var stderr strings.Builder
	cmd := exec.CommandContext(ctx, aiClaudeBin)
	cmd.Args = append(cmd.Args, args...)
	cmd.Dir, cmd.Env, cmd.Stdin, cmd.Stderr = work, env, strings.NewReader(stdin), &stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, fmt.Errorf("claude stdout: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, fmt.Errorf("start claude: %w", err)
	}
	return out, func() error {
		if err := cmd.Wait(); err != nil {
			return fmt.Errorf("claude: %w: %s", err, aiClip(stderr.String(), 500))
		}
		return nil
	}, nil
}

func (h *aiHandler) startMCP(ctx context.Context) {
	server := mcp.NewServer(&mcp.Implementation{Name: "gameplane", Version: "1"}, nil)
	server.AddTool(&mcp.Tool{
		Name:        aiTool.OfTool.Name,
		Description: aiToolDescription,
		InputSchema: map[string]any{"type": "object", "properties": aiToolProperties, "required": aiToolRequired},
	}, h.mcpCall)
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true})
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
	if run == nil {
		return nil, errors.New("this assistant run has ended")
	}
	var in aiToolInput
	text, failed := "", true
	if err := json.Unmarshal(req.Params.Arguments, &in); err != nil {
		text = "Invalid tool input: " + err.Error()
	} else if in.needsApproval() && !h.await(ctx, run, in) {
		text = "The user declined this action."
	} else {
		status, body := h.tool(ctx, run.conv, run.creds, in)
		text, failed = fmt.Sprintf("HTTP %d\n%s", status, body), status >= http.StatusBadRequest
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

func (h *aiHandler) untrack(run *aiLive) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.live[run.conv.ID] == run {
		delete(h.live, run.conv.ID)
	}
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
		if subtle.ConstantTimeCompare([]byte(run.token), []byte(token)) == 1 {
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
				Type      string      `json:"type"`
				ID        string      `json:"id"`
				ToolUseID string      `json:"tool_use_id"`
				Input     aiToolInput `json:"input"`
			} `json:"content"`
		}
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}
		for _, block := range msg.Content {
			switch {
			case block.Type == "tool_result":
				resolved[block.ToolUseID] = true
			case block.Type == "tool_use" && strings.EqualFold(block.Input.Method, in.Method) && block.Input.Path == in.Path:
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
