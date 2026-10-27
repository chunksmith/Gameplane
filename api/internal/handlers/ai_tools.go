package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/GameplanePanel/gameplane/netguard"
)

const (
	aiGrep         = "grep"
	aiGlob         = "glob"
	aiJobOutput    = "shell_output"
	aiJobStop      = "shell_stop"
	aiWebFetch     = "web_fetch"
	aiTodoWrite    = "todo_write"
	aiAskUser      = "ask_user"
	aiProposePlan  = "propose_plan"
	aiAskMethod    = "ASK"
	aiPlanMethod   = "PLAN"
	aiJobDir       = "/tmp/gameplane-jobs"
	aiGrepLines    = 500
	aiGlobFiles    = 500
	aiGlobScan     = 20000
	aiFetchMax     = 2 << 20
	aiFetchPage    = 40000
	aiFetchErrText = 2000
	aiMaxWait      = 50
	aiMaxAnswer    = 2000

	aiPlanText     = "Plan mode is on: this call changes something. Finish reading, then call propose_plan with your plan."
	aiPlanApproved = "The user approved the plan. Plan mode is off: carry it out now."
	aiPlanDeclined = "The user did not approve the plan. Ask what they want changed and keep planning."
)

var (
	aiJobIDRE      = regexp.MustCompile(`^[0-9a-f]{12}$`)
	aiTodoStatuses = []string{"pending", "in_progress", "completed"}
	aiScriptRE     = regexp.MustCompile(`(?is)<script[^>]*>.*?</script>`)
	aiStyleRE      = regexp.MustCompile(`(?is)<style[^>]*>.*?</style>`)
	aiBreakRE      = regexp.MustCompile(`(?i)<br\s*/?>|</(p|div|li|h[1-6]|tr)>`)
	aiTagRE        = regexp.MustCompile(`<[^>]+>`)
	aiFetchClient  = newAIFetchClient()
)

var aiCLITools = []aiToolSpec{
	{name: aiAskUser, description: "Ask the user one question with 2 to 4 answer options and wait for the answer. Use it when a choice changes the result and you cannot decide from the files. The user can also type their own answer.", properties: map[string]any{
		"question": map[string]any{"type": "string", "description": "The question, one sentence"},
		"options": map[string]any{"type": "array", "description": "The answer options", "items": map[string]any{"type": "object", "properties": map[string]any{
			"label":       map[string]any{"type": "string"},
			"description": map[string]any{"type": "string"},
		}, "required": []string{"label"}}},
		"multi_select": map[string]any{"type": "boolean", "description": "Let the user pick more than one option (default false)"},
	}, required: []string{"question", "options"}},
	{name: aiProposePlan, description: "In plan mode, present your finished plan (markdown, numbered steps naming the files and servers it changes) and wait for the user's approval. After approval plan mode is off and you carry the plan out.", properties: map[string]any{
		"plan": map[string]any{"type": "string", "description": "The plan in markdown"},
	}, required: []string{"plan"}},
}

func aiIsLocalTool(name string) bool {
	return aiIsFileTool(name) || slices.Contains([]string{aiWebFetch, aiTodoWrite, aiAskUser, aiProposePlan}, name)
}

func aiQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func aiDir(dir string) (string, error) {
	for _, part := range strings.Split(dir, "/") {
		if strings.HasPrefix(part, ".") {
			return "", errors.New("path must not contain dot-prefixed folders")
		}
	}
	return "." + path.Clean("/"+dir), nil
}

func aiGrepCommand(in aiFileInput) (string, error) {
	if in.Pattern == "" {
		return "", errors.New("pattern is required")
	}
	dir, err := aiDir(in.Dir)
	if err != nil {
		return "", err
	}
	mode := "-nHE"
	if in.FilesOnly {
		mode = "-lE"
	}
	if in.IgnoreCase {
		mode += "i"
	}
	args := []string{"find", aiQuote(dir), "-type", "f", "-not", "-path", aiQuote("*/.*")}
	if in.Glob != "" {
		args = append(args, "-name", aiQuote(in.Glob))
	}
	args = append(args, "-exec", "grep", mode, "-e", aiQuote(in.Pattern), "{}", "+", "2>/dev/null", "|", "head", "-n", fmt.Sprint(aiGrepLines+1))
	return strings.Join(args, " "), nil
}

func aiGlobCommand(in aiFileInput) (string, error) {
	dir, err := aiDir(in.Dir)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("find %s -type f -not -path %s 2>/dev/null | head -n %d", aiQuote(dir), aiQuote("*/.*"), aiGlobScan), nil
}

func aiGlobRegexp(pattern, dir string) (*regexp.Regexp, error) {
	pattern = strings.TrimPrefix(pattern, "/")
	prefix := strings.TrimSuffix(path.Clean("/"+dir), "/") + "/"
	var b strings.Builder
	b.WriteString("^" + regexp.QuoteMeta(prefix))
	if !strings.Contains(pattern, "/") {
		b.WriteString("(?:.*/)?")
	}
	runes := []rune(pattern)
	for i := 0; i < len(runes); i++ {
		switch {
		case runes[i] == '*' && i+2 < len(runes) && runes[i+1] == '*' && runes[i+2] == '/':
			b.WriteString("(?:.*/)?")
			i += 2
		case runes[i] == '*' && i+1 < len(runes) && runes[i+1] == '*':
			b.WriteString(".*")
			i++
		case runes[i] == '*':
			b.WriteString("[^/]*")
		case runes[i] == '?':
			b.WriteString("[^/]")
		default:
			b.WriteString(regexp.QuoteMeta(string(runes[i])))
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}

func aiPaths(out string) []string {
	if out == "" {
		return nil
	}
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	for i, line := range lines {
		lines[i] = strings.TrimPrefix(line, ".")
	}
	return lines
}

func aiListing(lines []string, none string, limit int) string {
	switch {
	case len(lines) == 0:
		return none
	case len(lines) > limit:
		return strings.Join(lines[:limit], "\n") + fmt.Sprintf("\n(stopped at %d lines; narrow path or glob)", limit)
	}
	return strings.Join(lines, "\n")
}

func (h *aiHandler) grep(ctx context.Context, conv aiConversation, creds aiCreds, in aiFileInput) (string, bool) {
	command, err := aiGrepCommand(in)
	if err != nil {
		return err.Error(), true
	}
	out, failure := h.runShell(ctx, conv, creds, in, command, 0)
	if failure != "" {
		return failure, true
	}
	return aiListing(aiPaths(out.Stdout), "No matches.", aiGrepLines), false
}

func (h *aiHandler) glob(ctx context.Context, conv aiConversation, creds aiCreds, in aiFileInput) (string, bool) {
	if in.Pattern == "" {
		return "pattern is required", true
	}
	command, err := aiGlobCommand(in)
	if err != nil {
		return err.Error(), true
	}
	re, err := aiGlobRegexp(in.Pattern, in.Dir)
	if err != nil {
		return "Invalid pattern: " + err.Error(), true
	}
	out, failure := h.runShell(ctx, conv, creds, in, command, 0)
	if failure != "" {
		return failure, true
	}
	var matches []string
	for _, p := range aiPaths(out.Stdout) {
		if re.MatchString(p) {
			matches = append(matches, p)
		}
	}
	slices.Sort(matches)
	return aiListing(matches, "No files found.", aiGlobFiles), false
}

func aiJobID() string {
	var buf [6]byte
	_, _ = rand.Read(buf[:])
	return hex.EncodeToString(buf[:])
}

func aiJobCheck(id string) error {
	if !aiJobIDRE.MatchString(id) {
		return errors.New("job_id is not a background job id")
	}
	return nil
}

func aiJobStartCommand(id, command string) string {
	return fmt.Sprintf(`mkdir -p %[1]s && { nohup sh -c 'sh -c "$1" > "$2.log" 2>&1; echo $? > "$2.exit"' gameplane-job %[2]s %[1]s/%[3]s > /dev/null 2>&1 & echo $! > %[1]s/%[3]s.pid; }`, aiJobDir, aiQuote(command), id)
}

func aiJobOutputCommand(id string, wait int) string {
	return fmt.Sprintf(`j=%[1]s/%[2]s; [ -f "$j.pid" ] || { echo 'status: gone'; exit 0; }; n=0; while [ ! -f "$j.exit" ] && [ $n -lt %[3]d ] && kill -0 "$(cat "$j.pid")" 2>/dev/null; do sleep 1; n=$((n+1)); done; if [ -f "$j.exit" ]; then echo "status: exited $(cat "$j.exit")"; elif kill -0 "$(cat "$j.pid")" 2>/dev/null; then echo 'status: running'; else echo 'status: gone'; fi; echo; tail -c 40000 "$j.log" 2>/dev/null`, aiJobDir, id, wait)
}

func aiJobStopCommand(id string) string {
	return fmt.Sprintf(`p=$(cat %[1]s/%[2]s.pid 2>/dev/null) && { pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null; }; echo stopped`, aiJobDir, id)
}

func (h *aiHandler) startJob(ctx context.Context, conv aiConversation, creds aiCreds, in aiFileInput) (string, bool) {
	id := aiJobID()
	out, failure := h.runShell(ctx, conv, creds, in, aiJobStartCommand(id, in.Command), 15)
	switch {
	case failure != "":
		return failure, true
	case out.ExitCode != 0:
		return aiShellOutput(out.Stdout, out.Stderr, out.ExitCode, out.Truncated), true
	}
	return fmt.Sprintf(`Started background job %s. Read it with shell_output {"job_id":"%s"}; stop it with shell_stop.`, id, id), false
}

func (h *aiHandler) jobOutput(ctx context.Context, conv aiConversation, creds aiCreds, in aiFileInput) (string, bool) {
	if err := aiJobCheck(in.JobID); err != nil {
		return err.Error(), true
	}
	wait := min(max(in.Wait, 0), aiMaxWait)
	out, failure := h.runShell(ctx, conv, creds, in, aiJobOutputCommand(in.JobID, wait), wait+5)
	if failure != "" {
		return failure, true
	}
	return aiClip(out.Stdout, aiMaxResult), false
}

func (h *aiHandler) jobStop(ctx context.Context, conv aiConversation, creds aiCreds, in aiFileInput) (string, bool) {
	if err := aiJobCheck(in.JobID); err != nil {
		return err.Error(), true
	}
	if _, failure := h.runShell(ctx, conv, creds, in, aiJobStopCommand(in.JobID), 15); failure != "" {
		return failure, true
	}
	return "Stopped background job " + in.JobID + ".", false
}

func newAIFetchClient() *http.Client {
	client := netguard.HTTPClient(30*time.Second, netguard.IsPublic)
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		switch {
		case len(via) > 5:
			return errors.New("too many redirects")
		case req.URL.Scheme != "http" && req.URL.Scheme != "https":
			return errors.New("redirect to a non-http address")
		case netguard.HostIsMetadata(req.URL.Hostname()):
			return netguard.ErrBlockedAddr
		}
		return nil
	}
	return client
}

func (h *aiHandler) webFetch(ctx context.Context, raw json.RawMessage) (string, bool) {
	var in struct {
		URL    string `json:"url"`
		Offset int    `json:"offset"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return "Invalid tool input: " + err.Error(), true
	}
	u, err := url.Parse(in.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "url must be an http or https URL", true
	}
	if netguard.HostIsMetadata(u.Hostname()) {
		return "this address is blocked", true
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "fetch failed: " + err.Error(), true
	}
	req.Header.Set("User-Agent", "Gameplane-Assistant")
	resp, err := aiFetchClient.Do(req)
	if err != nil {
		if errors.Is(err, netguard.ErrBlockedAddr) {
			return "this address is blocked", true
		}
		return "fetch failed: " + err.Error(), true
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, aiFetchMax))
	if err != nil {
		return "fetch failed: " + err.Error(), true
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Sprintf("HTTP %d\n%s", resp.StatusCode, aiClip(string(data), aiFetchErrText)), true
	}
	text := string(data)
	if strings.Contains(resp.Header.Get("Content-Type"), "html") {
		text = aiHTMLText(text)
	}
	return aiPage(text, in.Offset, resp.Request.URL.String()), false
}

func aiHTMLText(page string) string {
	text := aiScriptRE.ReplaceAllString(page, "")
	text = aiStyleRE.ReplaceAllString(text, "")
	text = aiBreakRE.ReplaceAllString(text, "\n")
	text = aiTagRE.ReplaceAllString(text, "")
	var lines []string
	for _, line := range strings.Split(html.UnescapeString(text), "\n") {
		line = strings.TrimSpace(line)
		if line == "" && (len(lines) == 0 || lines[len(lines)-1] == "") {
			continue
		}
		lines = append(lines, line)
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func aiPage(text string, offset int, source string) string {
	runes := []rune(text)
	start := min(max(offset, 0), len(runes))
	end := min(start+aiFetchPage, len(runes))
	out := fmt.Sprintf("URL: %s (characters %d-%d of %d)\n\n%s", source, start, end, len(runes), string(runes[start:end]))
	if end < len(runes) {
		out += fmt.Sprintf("\n\n(continue with offset=%d)", end)
	}
	return out
}

func aiTodoWriteTool(raw json.RawMessage) (string, bool) {
	var in struct {
		Todos []struct {
			Content string `json:"content"`
			Status  string `json:"status"`
		} `json:"todos"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return "Invalid tool input: " + err.Error(), true
	}
	if len(in.Todos) == 0 {
		return "todos must list at least one task", true
	}
	for _, todo := range in.Todos {
		if !slices.Contains(aiTodoStatuses, todo.Status) {
			return "status must be pending, in_progress or completed", true
		}
	}
	return "Todos updated.", false
}

func aiPlanBlocked(mode, name string, raw json.RawMessage) bool {
	if mode != aiModePlan {
		return false
	}
	switch {
	case slices.Contains([]string{aiEditFile, aiWriteFile, aiShell, aiJobStop}, name):
		return true
	case name == "gameplane_api":
		var in aiToolInput
		return json.Unmarshal(raw, &in) != nil || !strings.EqualFold(in.Method, http.MethodGet)
	case strings.HasPrefix(name, aiLinearPrefix):
		return aiToolUse{name: name}.needsApproval()
	}
	return false
}
