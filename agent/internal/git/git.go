// Package git serves the repository agent Git routes by running the git CLI.
package git

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/GameplanePanel/gameplane/agent/internal/httpjson"
	"github.com/GameplanePanel/gameplane/netguard"
)

const (
	tokenHeader       = "X-Gameplane-Git-Token"
	authorNameHeader  = "X-Gameplane-Git-Author-Name"
	authorEmailHeader = "X-Gameplane-Git-Author-Email"

	askpassEnv     = "GAMEPLANE_GIT_ASKPASS"
	tokenEnv       = "GAMEPLANE_GIT_TOKEN"
	tokenUser      = "x-access-token"
	redacted       = "[REDACTED]"
	maxDiffBytes   = 5 << 20
	maxOutputBytes = 64 << 10
	maxBodyBytes   = 1 << 20
	commandTimeout = 10 * time.Minute
	cloneTimeout   = 30 * time.Minute
)

var githubRemote = regexp.MustCompile(`^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// Askpass answers a GIT_ASKPASS prompt when the process runs as the askpass helper.
func Askpass() bool {
	if os.Getenv(askpassEnv) != "1" {
		return false
	}
	answer := os.Getenv(tokenEnv)
	if len(os.Args) > 1 && strings.HasPrefix(os.Args[1], "Username") {
		answer = tokenUser
	}
	_, _ = fmt.Fprintln(os.Stdout, answer)
	return true
}

type gitError struct {
	status  int
	Code    string   `json:"code"`
	Message string   `json:"message"`
	Output  string   `json:"output,omitempty"`
	Files   []string `json:"files,omitempty"`
	Commit  *commit  `json:"commit,omitempty"`
}

func (e *gitError) Error() string {
	return e.Message
}

func fail(status int, code, message string) *gitError {
	return &gitError{status: status, Code: code, Message: message}
}

var (
	errBusy          = fail(http.StatusConflict, "busy", "another git command is running")
	errTokenRequired = fail(http.StatusPreconditionRequired, "github_token_required", "a GitHub token is required")
	errRemote        = fail(http.StatusBadRequest, "remote_not_allowed", "remote must be an HTTPS github.com repository")
	errGitDir        = fail(http.StatusForbidden, "git_dir", "the .git directory is not accessible")
)

func badRequest(message string) *gitError {
	return fail(http.StatusBadRequest, "bad_request", message)
}

type handler struct {
	dir         string
	askpass     string
	checkRemote func(context.Context, string) error
	mu          sync.Mutex
	cloneMu     sync.Mutex
	clone       cloneState
}

func checkGitHub(ctx context.Context, remote string) error {
	if !githubRemote.MatchString(remote) {
		return errRemote
	}
	if err := netguard.CheckHostAllowed(ctx, "github.com", netguard.IsPublic); err != nil {
		return fmt.Errorf("github.com: %w", err)
	}
	return nil
}

// Routes returns a mounter for the /git routes of the working copy at dir; every
// router it is applied to shares one repository lock.
func Routes(dir string) func(chi.Router) {
	self, err := os.Executable()
	if err != nil {
		slog.Warn("git askpass unavailable", "err", err)
	}
	return newHandler(dir, self, checkGitHub).mount
}

func newHandler(dir, askpass string, checkRemote func(context.Context, string) error) *handler {
	return &handler{dir: filepath.Clean(dir), askpass: askpass, checkRemote: checkRemote, clone: cloneState{State: "idle"}}
}

func (h *handler) mount(r chi.Router) {
	r.Route("/git", func(r chi.Router) {
		r.Get("/status", h.reader(h.status))
		r.Get("/diff", h.reader(h.diff))
		r.Get("/log", h.reader(h.log))
		r.Get("/commits/{sha}", h.reader(h.show))
		r.Get("/branches", h.reader(h.branches))
		r.Get("/clone", h.cloneStatus)
		r.Post("/stage", h.writer(h.stage))
		r.Post("/unstage", h.writer(h.unstage))
		r.Post("/discard", h.writer(h.discard))
		r.Post("/commit", h.writer(h.commit))
		r.Post("/revert", h.writer(h.revert))
		r.Post("/undo", h.writer(h.undo))
		r.Post("/branches", h.writer(h.createBranch))
		r.Post("/checkout", h.writer(h.checkout))
		r.Post("/fetch", h.writer(h.fetch))
		r.Post("/pull", h.writer(h.pull))
		r.Post("/push", h.writer(h.push))
		r.Post("/clone", h.startClone)
	})
}

type call struct {
	h        *handler
	ctx      context.Context
	req      *http.Request
	token    string
	readOnly bool
	env      []string
	progress func(string)
}

type diffText string

func (h *handler) newCall(req *http.Request, readOnly bool) (*call, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(req.Context()), commandTimeout)
	return &call{h: h, ctx: ctx, req: req, token: req.Header.Get(tokenHeader), readOnly: readOnly}, cancel
}

func (h *handler) reader(op func(*call) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		c, cancel := h.newCall(req, true)
		defer cancel()
		c.respond(w, op)
	}
}

func (h *handler) writer(op func(*call) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		if !h.mu.TryLock() {
			writeError(w, errBusy)
			return
		}
		defer h.mu.Unlock()
		c, cancel := h.newCall(req, false)
		defer cancel()
		c.respond(w, op)
	}
}

func (c *call) respond(w http.ResponseWriter, op func(*call) (any, error)) {
	out, err := op(c)
	if err != nil {
		writeError(w, c.wrap(err))
		return
	}
	if text, ok := out.(diffText); ok {
		w.Header().Set("Content-Type", "text/x-diff; charset=utf-8")
		_, _ = io.WriteString(w, string(text))
		return
	}
	httpjson.Write(w, http.StatusOK, out)
}

func (c *call) wrap(err error) *gitError {
	var gitErr *gitError
	if errors.As(err, &gitErr) {
		return gitErr
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return fail(http.StatusRequestEntityTooLarge, "too_large", "request body too large")
	}
	slog.Warn("git internal error", "err", c.redact(err.Error()))
	return fail(http.StatusInternalServerError, "internal", c.redact(err.Error()))
}

func writeError(w http.ResponseWriter, err *gitError) {
	httpjson.Write(w, err.status, err)
}

func (c *call) redact(text string) string {
	if c.token == "" {
		return text
	}
	return strings.ReplaceAll(text, c.token, redacted)
}

func (c *call) decode(dst any) error {
	body := http.MaxBytesReader(nil, c.req.Body, maxBodyBytes)
	if err := json.NewDecoder(body).Decode(dst); err != nil && !errors.Is(err, io.EOF) {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return fmt.Errorf("decode body: %w", err)
		}
		return badRequest("invalid JSON body")
	}
	return nil
}

func (c *call) requireNetwork() (string, error) {
	if c.token == "" {
		return "", errTokenRequired
	}
	remote, err := c.output("remote", "get-url", "origin")
	if err != nil {
		return "", err
	}
	remote = strings.TrimSpace(remote)
	if err := c.h.checkRemote(c.ctx, remote); err != nil {
		return "", err
	}
	return remote, nil
}

func (c *call) run(network bool, stdin io.Reader, stdout io.Writer, args ...string) error {
	full := append([]string{"-c", "safe.directory=*", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper="}, args...)
	cmd := exec.CommandContext(c.ctx, "git", full...)
	cmd.Dir = c.h.dir
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		"LC_ALL=C",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_AUTHOR_NAME=Gameplane",
		"GIT_AUTHOR_EMAIL=gameplane@localhost",
		"GIT_COMMITTER_NAME=Gameplane",
		"GIT_COMMITTER_EMAIL=gameplane@localhost",
	}
	if c.readOnly {
		cmd.Env = append(cmd.Env, "GIT_OPTIONAL_LOCKS=0")
	}
	if network {
		cmd.Env = append(cmd.Env, "GIT_ASKPASS="+c.h.askpass, askpassEnv+"=1", tokenEnv+"="+c.token)
	}
	cmd.Env = append(cmd.Env, c.env...)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	stderr := &tailBuffer{max: maxOutputBytes, onLine: c.progress}
	cmd.Stderr = stderr
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Run(); err != nil {
		return &gitError{
			status:  http.StatusUnprocessableEntity,
			Code:    "git_failed",
			Message: c.redact(fmt.Sprintf("git %s: %v", args[0], err)),
			Output:  c.redact(strings.TrimSpace(stderr.String())),
		}
	}
	return nil
}

func (c *call) output(args ...string) (string, error) {
	var out bytes.Buffer
	err := c.run(false, nil, &out, args...)
	return out.String(), err
}

func (c *call) succeeds(args ...string) bool {
	return c.run(false, nil, io.Discard, args...) == nil
}

func (c *call) network(args ...string) error {
	return c.run(true, nil, io.Discard, args...)
}

type cappedBuffer struct {
	bytes.Buffer
	max  int
	over bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	room := b.max - b.Len()
	if len(p) > room {
		b.over = true
		_, _ = b.Buffer.Write(p[:max(room, 0)])
		return len(p), nil
	}
	return b.Buffer.Write(p)
}

type tailBuffer struct {
	buf    []byte
	line   []byte
	max    int
	onLine func(string)
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.buf = append(b.buf, p...)
	if len(b.buf) > b.max {
		b.buf = b.buf[len(b.buf)-b.max:]
	}
	if b.onLine != nil {
		for _, ch := range p {
			if ch == '\r' || ch == '\n' {
				b.onLine(string(b.line))
				b.line = b.line[:0]
				continue
			}
			b.line = append(b.line, ch)
		}
	}
	return len(p), nil
}

func (b *tailBuffer) String() string {
	return string(b.buf)
}
