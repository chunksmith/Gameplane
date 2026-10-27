package handlers

import (
	"cmp"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/db"
	"github.com/GameplanePanel/gameplane/api/internal/httperr"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
	"github.com/GameplanePanel/gameplane/api/internal/rbac"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

const (
	aiConfigSection = "ai"
	aiSecretName    = "gameplane-ai"
	aiSecretLabel   = "gameplane.local/ai"
	aiMaxPrompt     = 20000
	aiMaxAttachment = 5

	aiRunning  = "running"
	aiAwaiting = "awaiting_approval"
	aiIdle     = "idle"
	aiFailed   = "error"

	aiModeDefault = "default"
	aiModeAuto    = "auto"
	aiModeBypass  = "bypassPermissions"
	aiModePlan    = "plan"

	aiColumns = `c.id, c.user_id, COALESCE(u.username, ''), c.title, c.cluster, c.namespace, c.server, c.model, c.effort, c.status, c.error, c.input_tokens, c.output_tokens, c.created_at, c.updated_at, c.session_id, c.permission_mode`
	aiFrom    = ` FROM ai_conversations c LEFT JOIN users u ON u.id = c.user_id`
	aiListOwn = `SELECT ` + aiColumns + aiFrom + ` WHERE c.user_id = ? AND c.server = ? AND c.namespace = ? AND c.cluster = ? ORDER BY c.updated_at DESC LIMIT 200`
	aiListAll = `SELECT ` + aiColumns + aiFrom + ` ORDER BY c.updated_at DESC LIMIT 200`
	aiGetOne  = `SELECT ` + aiColumns + aiFrom + ` WHERE c.id = ?`
)

var (
	aiModels     = []string{"claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"}
	aiEfforts    = []string{"low", "medium", "high", "xhigh", "max"}
	aiModes      = []string{aiModeDefault, aiModeAuto, aiModeBypass, aiModePlan}
	aiImageTypes = []string{"image/jpeg", "image/png", "image/gif", "image/webp"}
	errAIStopped = errors.New("ai run stopped")
)

type aiSettings struct {
	Enabled         bool   `json:"enabled"`
	DefaultModel    string `json:"defaultModel"`
	DefaultEffort   string `json:"defaultEffort"`
	DefaultMode     string `json:"defaultMode"`
	APIKeySet       bool   `json:"apiKeySet"`
	SubscriptionSet bool   `json:"subscriptionSet,omitempty"`
	LinearEnabled   bool   `json:"linearEnabled,omitempty"`
	LinearComment   bool   `json:"linearComment,omitempty"`
	LinearWrite     bool   `json:"linearWrite,omitempty"`
}

type aiConversation struct {
	ID           string `json:"id"`
	UserID       int64  `json:"userId"`
	Username     string `json:"username"`
	Title        string `json:"title"`
	Cluster      string `json:"cluster"`
	Namespace    string `json:"namespace"`
	Server       string `json:"server"`
	Model        string `json:"model"`
	Effort       string `json:"effort"`
	Mode         string `json:"mode"`
	Status       string `json:"status"`
	Error        string `json:"error"`
	InputTokens  int64  `json:"inputTokens"`
	OutputTokens int64  `json:"outputTokens"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
	SessionID    string `json:"-"`
}

type aiCreds struct {
	cookie     string
	csrf       string
	remoteAddr string
	admin      bool
}

type aiHandler struct {
	store      *db.Store
	router     http.Handler
	key        func(context.Context) (string, bool)
	linearKeys AILinearKeys
	dialLinear func(context.Context, string) (*mcp.ClientSession, error)
	send       func(context.Context, string, anthropic.BetaMessageNewParams, func(string)) (*anthropic.BetaMessage, error)
	spawn      func(context.Context, []string, ...string) (io.WriteCloser, io.ReadCloser, func() error, error)
	idle       time.Duration
	mcpOnce    sync.Once
	mcpURL     string
	mu         sync.Mutex
	live       map[string]*aiLive
	procs      map[string]*aiProc

	streamMu sync.Mutex
	streams  map[string]*aiStream
}

// MountAI wires the AI assistant routes; its tool calls replay through router with the caller's own session.
func MountAI(r chi.Router, store *db.Store, router http.Handler, key func(context.Context) (string, bool), linearKeys AILinearKeys) {
	(&aiHandler{store: store, router: router, key: key, linearKeys: linearKeys, dialLinear: dialLinear, send: sendClaude, spawn: spawnClaude}).mount(r)
}

// MountAISecret wires the admin routes that store and remove the assistant's Claude credential.
func MountAISecret(r chi.Router, k *kube.Client, controlNS string) {
	r.Put("/admin/ai/secret", func(w http.ResponseWriter, req *http.Request) {
		var body struct {
			APIKey     string `json:"apiKey"`
			OAuthToken string `json:"oauthToken"`
		}
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		key, token := strings.TrimSpace(body.APIKey), strings.TrimSpace(body.OAuthToken)
		if (key == "") == (token == "") {
			http.Error(w, "exactly one of apiKey or oauthToken is required", http.StatusUnprocessableEntity)
			return
		}
		err := upsertLabelledSecret(req.Context(), k, controlNS, aiSecretName, aiSecretLabel, map[string]string{"apiKey": key, "oauthToken": token})
		if errors.Is(err, errNotManagedSecret) {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		if err != nil {
			httperr.Write(w, req, err)
			return
		}
		writeJSON(w, map[string]any{"name": aiSecretName, "keys": []string{"apiKey", "oauthToken"}})
	})
	r.Delete("/admin/ai/secret", func(w http.ResponseWriter, req *http.Request) {
		if err := deleteManagedSecret(req.Context(), k, controlNS, aiSecretName, aiSecretLabel); err != nil {
			httperr.Write(w, req, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

// AIKeyReader returns a lookup of the assistant's Claude credential in its labelled Secret: the subscription token (true) when one is set, otherwise the API key; the lookup yields "" when neither is set.
func AIKeyReader(k *kube.Client, controlNS string) func(context.Context) (string, bool) {
	return func(ctx context.Context) (string, bool) {
		secrets := k.Secrets(controlNS)
		if secrets == nil {
			return "", false
		}
		sec, err := secrets.Get(ctx, aiSecretName, metav1.GetOptions{})
		if err != nil || sec.Labels[aiSecretLabel] != "true" {
			return "", false
		}
		if token := string(sec.Data["oauthToken"]); token != "" {
			return token, true
		}
		return string(sec.Data["apiKey"]), false
	}
}

func (h *aiHandler) mount(r chi.Router) {
	if _, err := h.store.DB.ExecContext(context.Background(), `UPDATE ai_conversations SET status = ?, error = ? WHERE status = ? OR (status = ? AND session_id <> '')`,
		aiFailed, "Interrupted by an API restart.", aiRunning, aiAwaiting); err != nil {
		slog.Warn("reset interrupted ai runs", "err", err)
	}
	r.Get("/ai/status", h.status)
	r.Get("/ai/linear", h.myLinear)
	r.Put("/ai/linear/key", h.putLinearKey)
	r.Delete("/ai/linear/key", h.deleteLinearKey)
	r.Get("/ai/linear/issues", h.linearIssues)
	r.Get("/ai/conversations", h.list)
	r.Post("/ai/conversations", h.create)
	r.Post("/ai/warm", h.warm)
	r.Get("/ai/conversations/{id}", h.get)
	r.Post("/ai/conversations/{id}/warm", h.warm)
	r.Get("/ai/conversations/{id}/stream", h.sse)
	r.Post("/ai/conversations/{id}/messages", h.post)
	r.Post("/ai/conversations/{id}/approval", h.approval)
	r.Post("/ai/conversations/{id}/answer", h.answerQuestion)
	r.Post("/ai/conversations/{id}/cancel", h.cancel)
}

func validateAI(body []byte) (json.RawMessage, error) {
	var s aiSettings
	if err := json.Unmarshal(body, &s); err != nil {
		return nil, fmt.Errorf("invalid json: %w", err)
	}
	s = s.withDefaults()
	if err := cmp.Or(aiCheckModel(s.DefaultModel, s.DefaultEffort), aiCheckMode(s.DefaultMode)); err != nil {
		return nil, err
	}
	return json.Marshal(s)
}

func (s aiSettings) withDefaults() aiSettings {
	s.DefaultModel = cmp.Or(s.DefaultModel, aiModels[0])
	s.DefaultEffort = cmp.Or(s.DefaultEffort, "medium")
	s.DefaultMode = cmp.Or(s.DefaultMode, aiModeDefault)
	return s
}

func aiCheckModel(model, effort string) error {
	if !slices.Contains(aiModels, model) {
		return fmt.Errorf("model must be one of %s", strings.Join(aiModels, ", "))
	}
	if !slices.Contains(aiEfforts, effort) {
		return fmt.Errorf("effort must be one of %s", strings.Join(aiEfforts, ", "))
	}
	return nil
}

func aiCheckMode(mode string) error {
	if !slices.Contains(aiModes, mode) {
		return fmt.Errorf("mode must be one of %s", strings.Join(aiModes, ", "))
	}
	return nil
}

type aiAttachment struct {
	Name      string `json:"name"`
	MediaType string `json:"mediaType"`
	Data      string `json:"data"`
}

func aiDecode(w http.ResponseWriter, req *http.Request, body any) bool {
	err := json.NewDecoder(req.Body).Decode(body)
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		http.Error(w, "the message and its attachments must be at most 1 MiB", http.StatusRequestEntityTooLarge)
	case err != nil:
		http.Error(w, "invalid json", http.StatusBadRequest)
	}
	return err == nil
}

func aiContent(prompt string, attachments []aiAttachment) ([]anthropic.BetaContentBlockParamUnion, error) {
	if len(attachments) > aiMaxAttachment {
		return nil, fmt.Errorf("at most %d attachments are allowed", aiMaxAttachment)
	}
	blocks := make([]anthropic.BetaContentBlockParamUnion, 0, len(attachments)+1)
	for _, attachment := range attachments {
		data, err := base64.StdEncoding.DecodeString(attachment.Data)
		if err != nil || len(data) == 0 {
			return nil, fmt.Errorf("attachment %q is empty or not base64", attachment.Name)
		}
		var block anthropic.BetaContentBlockParamUnion
		switch {
		case slices.Contains(aiImageTypes, attachment.MediaType):
			block = anthropic.NewBetaImageBlock(anthropic.BetaBase64ImageSourceParam{Data: attachment.Data, MediaType: anthropic.BetaBase64ImageSourceMediaType(attachment.MediaType)})
		case attachment.MediaType == "application/pdf":
			block = anthropic.NewBetaDocumentBlock(anthropic.BetaBase64PDFSourceParam{Data: attachment.Data})
		case utf8.Valid(data):
			block = anthropic.NewBetaDocumentBlock(anthropic.BetaPlainTextSourceParam{Data: string(data)})
		default:
			return nil, fmt.Errorf("attachment %q must be an image, a PDF or a text file", attachment.Name)
		}
		if block.OfDocument != nil {
			block.OfDocument.Title = anthropic.String(cmp.Or(attachment.Name, "attachment"))
		}
		blocks = append(blocks, block)
	}
	return append(blocks, anthropic.NewBetaTextBlock(prompt)), nil
}

func aiCheckPrompt(prompt string) error {
	if prompt == "" {
		return errors.New("prompt is required")
	}
	if utf8.RuneCountInString(prompt) > aiMaxPrompt {
		return fmt.Errorf("prompt must be at most %d characters", aiMaxPrompt)
	}
	return nil
}

func (h *aiHandler) settings(ctx context.Context) aiSettings {
	var s aiSettings
	if raw, ok, err := h.store.ConfigValue(ctx, aiConfigSection); err == nil && ok {
		_ = json.Unmarshal([]byte(raw), &s)
	}
	return s.withDefaults()
}

func (h *aiHandler) ready(w http.ResponseWriter, req *http.Request) (aiSettings, string, bool, bool) {
	s := h.settings(req.Context())
	if !s.Enabled {
		http.Error(w, "the AI assistant is disabled", http.StatusForbidden)
		return s, "", false, false
	}
	key, sub := h.key(req.Context())
	if key == "" {
		http.Error(w, "the AI assistant has no API key configured", http.StatusServiceUnavailable)
		return s, "", false, false
	}
	return s, key, sub, true
}

func (h *aiHandler) status(w http.ResponseWriter, req *http.Request) {
	key, _ := h.key(req.Context())
	s := h.settings(req.Context())
	writeJSON(w, map[string]any{
		"enabled":       s.Enabled,
		"configured":    key != "",
		"defaultModel":  s.DefaultModel,
		"defaultEffort": s.DefaultEffort,
		"defaultMode":   s.DefaultMode,
		"linear":        s.LinearEnabled && h.linearKeys.get(req.Context(), auth.UserFromContext(req.Context()).ID) != "",
	})
}

func (h *aiHandler) list(w http.ResponseWriter, req *http.Request) {
	u := auth.UserFromContext(req.Context())
	q := req.URL.Query()
	var rows *sql.Rows
	var err error
	if q.Get("scope") == "all" {
		if !u.Can("audit:read", false, scope.DefaultCluster, "") {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		rows, err = h.store.DB.QueryContext(req.Context(), aiListAll)
	} else {
		server, namespace, cluster := aiScope(q.Get("server"), q.Get("namespace"), q.Get("cluster"))
		rows, err = h.store.DB.QueryContext(req.Context(), aiListOwn, u.ID, server, namespace, cluster)
	}
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []aiConversation{}
	for rows.Next() {
		conv, err := scanAIConversation(rows)
		if err != nil {
			httperr.Write(w, req, err)
			return
		}
		out = append(out, conv)
	}
	if err := rows.Err(); err != nil {
		httperr.Write(w, req, err)
		return
	}
	writeJSON(w, out)
}

func (h *aiHandler) create(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Prompt      string         `json:"prompt"`
		Server      string         `json:"server"`
		Namespace   string         `json:"namespace"`
		Cluster     string         `json:"cluster"`
		Model       string         `json:"model"`
		Effort      string         `json:"effort"`
		Mode        string         `json:"mode"`
		Attachments []aiAttachment `json:"attachments"`
	}
	if !aiDecode(w, req, &body) {
		return
	}
	s, key, sub, ok := h.ready(w, req)
	if !ok {
		return
	}
	prompt := strings.TrimSpace(body.Prompt)
	model, effort := cmp.Or(body.Model, s.DefaultModel), cmp.Or(body.Effort, s.DefaultEffort)
	mode := cmp.Or(body.Mode, s.DefaultMode)
	server, namespace, cluster := aiScope(body.Server, body.Namespace, body.Cluster)
	content, err := aiContent(prompt, body.Attachments)
	err = cmp.Or(aiCheckPrompt(prompt), aiCheckModel(model, effort), aiCheckMode(mode), err)
	if err == nil && server != "" && (!dnsLabelRE.MatchString(server) || namespace == "") {
		err = errors.New("server must be a DNS label and namespace is required")
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	ctx := context.WithoutCancel(req.Context())
	creds := aiCredentials(req)
	if server != "" {
		target := aiTarget("/servers/"+server, url.Values{"namespace": {namespace}, "cluster": {cluster}})
		if status, _ := h.call(ctx, creds, http.MethodGet, target, nil, ""); status != http.StatusOK {
			http.Error(w, "server not found", http.StatusNotFound)
			return
		}
	}
	u := auth.UserFromContext(req.Context())
	now := aiNow()
	runID := rand.Text()
	conv := aiConversation{
		ID: rand.Text(), UserID: u.ID, Username: u.Username, Title: aiTitle(prompt),
		Cluster: cluster, Namespace: namespace, Server: server, Model: model, Effort: effort, Mode: mode,
		Status: aiRunning, CreatedAt: now, UpdatedAt: now,
	}
	if _, err := h.store.DB.ExecContext(req.Context(),
		`INSERT INTO ai_conversations(id, user_id, title, cluster, namespace, server, model, effort, permission_mode, status, error, run_id, input_tokens, output_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, 0, 0, ?, ?)`,
		conv.ID, conv.UserID, conv.Title, conv.Cluster, conv.Namespace, conv.Server, conv.Model, conv.Effort, conv.Mode, conv.Status, runID, now, now); err != nil {
		httperr.Write(w, req, err)
		return
	}
	if err := h.appendMessage(req.Context(), conv.ID, runID, anthropic.NewBetaUserMessage(content...)); err != nil {
		httperr.Write(w, req, err)
		return
	}
	h.adopt(aiNewChat(u.ID), conv.ID)
	h.begin(ctx, conv, creds, key, sub, runID, content)
	writeJSONCreated(w, conv)
}

func (h *aiHandler) warm(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Server    string `json:"server"`
		Namespace string `json:"namespace"`
		Cluster   string `json:"cluster"`
		Model     string `json:"model"`
		Effort    string `json:"effort"`
		Mode      string `json:"mode"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	s, key, sub, ok := h.ready(w, req)
	if !ok {
		return
	}
	u := auth.UserFromContext(req.Context())
	conv := aiConversation{ID: aiNewChat(u.ID), UserID: u.ID, Model: s.DefaultModel, Effort: s.DefaultEffort, Mode: s.DefaultMode}
	conv.Server, conv.Namespace, conv.Cluster = aiScope(body.Server, body.Namespace, body.Cluster)
	if chi.URLParam(req, "id") != "" {
		if conv, ok = h.load(w, req, true); !ok {
			return
		}
	}
	conv.Model, conv.Effort, conv.Mode = cmp.Or(body.Model, conv.Model), cmp.Or(body.Effort, conv.Effort), cmp.Or(body.Mode, conv.Mode)
	err := cmp.Or(aiCheckModel(conv.Model, conv.Effort), aiCheckMode(conv.Mode))
	if err == nil && conv.Server != "" && (!dnsLabelRE.MatchString(conv.Server) || conv.Namespace == "") {
		err = errors.New("server must be a DNS label and namespace is required")
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if sub && conv.Status != aiRunning && conv.Status != aiAwaiting {
		go h.warmCLI(context.WithoutCancel(req.Context()), conv, aiCredentials(req), key)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *aiHandler) get(w http.ResponseWriter, req *http.Request) {
	conv, ok := h.load(w, req, false)
	if !ok {
		return
	}
	msgs, err := h.messages(req.Context(), conv.ID)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	pending := []map[string]string{}
	if in := h.waitingInput(conv.ID); conv.Status == aiAwaiting && in != nil {
		pending = append(pending, map[string]string{"id": aiPendingID(msgs, *in), "method": strings.ToUpper(in.Method), "path": in.Path})
	} else if conv.Status == aiAwaiting {
		for _, use := range aiToolUses(msgs) {
			if use.needsApproval() {
				pending = append(pending, map[string]string{"id": use.id, "method": use.method(), "path": use.target()})
			}
		}
	}
	writeJSON(w, map[string]any{"conversation": conv, "messages": msgs, "pending": pending})
}

func (h *aiHandler) post(w http.ResponseWriter, req *http.Request) {
	conv, ok := h.load(w, req, true)
	if !ok {
		return
	}
	var body struct {
		Prompt      string         `json:"prompt"`
		Mode        string         `json:"mode"`
		Model       string         `json:"model"`
		Effort      string         `json:"effort"`
		Attachments []aiAttachment `json:"attachments"`
	}
	if !aiDecode(w, req, &body) {
		return
	}
	prompt := strings.TrimSpace(body.Prompt)
	conv.Mode = cmp.Or(body.Mode, conv.Mode)
	conv.Model, conv.Effort = cmp.Or(body.Model, conv.Model), cmp.Or(body.Effort, conv.Effort)
	content, err := aiContent(prompt, body.Attachments)
	if err := cmp.Or(aiCheckPrompt(prompt), aiCheckModel(conv.Model, conv.Effort), aiCheckMode(conv.Mode), err); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	_, key, sub, ok := h.ready(w, req)
	if !ok {
		return
	}
	runID, ok := h.start(w, req, conv.ID, aiIdle, aiFailed)
	if !ok {
		return
	}
	if _, err := h.store.DB.ExecContext(req.Context(), `UPDATE ai_conversations SET permission_mode = ?, model = ?, effort = ? WHERE id = ?`, conv.Mode, conv.Model, conv.Effort, conv.ID); err != nil {
		h.settle(req.Context(), conv.ID, runID, aiFailed, "Could not save the permission mode.")
		httperr.Write(w, req, err)
		return
	}
	msgs, err := h.messages(req.Context(), conv.ID)
	if err != nil {
		h.settle(req.Context(), conv.ID, runID, aiFailed, "Could not load the conversation.")
		httperr.Write(w, req, err)
		return
	}
	blocks := []anthropic.BetaContentBlockParamUnion{}
	for _, use := range aiToolUses(msgs) {
		blocks = append(blocks, anthropic.NewBetaToolResultBlock(use.id, "Interrupted: the run was stopped before this call's result was recorded.", true))
	}
	blocks = append(blocks, content...)
	if err := h.appendMessage(req.Context(), conv.ID, runID, anthropic.NewBetaUserMessage(blocks...)); err != nil {
		h.settle(req.Context(), conv.ID, runID, aiFailed, "Could not save the message.")
		httperr.Write(w, req, err)
		return
	}
	conv.Status, conv.Error = aiRunning, ""
	h.begin(context.WithoutCancel(req.Context()), conv, aiCredentials(req), key, sub, runID, content)
	writeJSON(w, conv)
}

func (h *aiHandler) approval(w http.ResponseWriter, req *http.Request) {
	conv, ok := h.load(w, req, true)
	if !ok {
		return
	}
	var body struct {
		Approve bool `json:"approve"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	_, key, sub, ok := h.ready(w, req)
	if !ok {
		return
	}
	if sub {
		if !h.decide(req.Context(), conv.ID, body.Approve) {
			http.Error(w, "the conversation is busy or not waiting for this action", http.StatusConflict)
			return
		}
		conv.Status, conv.Error = aiRunning, ""
		writeJSON(w, conv)
		return
	}
	runID, ok := h.start(w, req, conv.ID, aiAwaiting, aiAwaiting)
	if !ok {
		return
	}
	conv.Status, conv.Error = aiRunning, ""
	go h.run(context.WithoutCancel(req.Context()), conv, aiCredentials(req), key, runID, &body.Approve)
	writeJSON(w, conv)
}

func (h *aiHandler) answerQuestion(w http.ResponseWriter, req *http.Request) {
	conv, ok := h.load(w, req, true)
	if !ok {
		return
	}
	var body struct {
		Answer string `json:"answer"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	answer := strings.TrimSpace(body.Answer)
	if utf8.RuneCountInString(answer) > aiMaxAnswer {
		http.Error(w, "answer is too long", http.StatusBadRequest)
		return
	}
	if !h.answer(req.Context(), conv.ID, answer) {
		http.Error(w, "the conversation is not waiting for an answer", http.StatusConflict)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *aiHandler) cancel(w http.ResponseWriter, req *http.Request) {
	conv, ok := h.load(w, req, true)
	if !ok {
		return
	}
	res, err := h.store.DB.ExecContext(req.Context(),
		`UPDATE ai_conversations SET status = ?, error = ?, run_id = '', updated_at = ? WHERE id = ? AND (status = ? OR status = ?)`,
		aiIdle, "Stopped by the user.", aiNow(), conv.ID, aiRunning, aiAwaiting)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	if n, err := res.RowsAffected(); err != nil || n == 0 {
		http.Error(w, "the assistant is not running", http.StatusConflict)
		return
	}
	h.stop(conv.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (h *aiHandler) load(w http.ResponseWriter, req *http.Request, write bool) (aiConversation, bool) {
	u := auth.UserFromContext(req.Context())
	conv, err := scanAIConversation(h.store.DB.QueryRowContext(req.Context(), aiGetOne, chi.URLParam(req, "id")))
	hidden := err == nil && conv.UserID != u.ID && (write || !u.Can("audit:read", false, scope.DefaultCluster, ""))
	if errors.Is(err, sql.ErrNoRows) || hidden {
		http.Error(w, "conversation not found", http.StatusNotFound)
		return conv, false
	}
	if err != nil {
		httperr.Write(w, req, err)
		return conv, false
	}
	return conv, true
}

func (h *aiHandler) start(w http.ResponseWriter, req *http.Request, id, from, alsoFrom string) (string, bool) {
	runID := rand.Text()
	res, err := h.store.DB.ExecContext(req.Context(),
		`UPDATE ai_conversations SET status = ?, error = '', run_id = ?, updated_at = ? WHERE id = ? AND (status = ? OR status = ?)`,
		aiRunning, runID, aiNow(), id, from, alsoFrom)
	if err != nil {
		httperr.Write(w, req, err)
		return "", false
	}
	if n, err := res.RowsAffected(); err != nil || n == 0 {
		http.Error(w, "the conversation is busy or not waiting for this action", http.StatusConflict)
		return "", false
	}
	return runID, true
}

func (h *aiHandler) messages(ctx context.Context, id string) ([]json.RawMessage, error) {
	rows, err := h.store.DB.QueryContext(ctx, `SELECT message FROM ai_messages WHERE conversation_id = ? ORDER BY seq`, id)
	if err != nil {
		return nil, fmt.Errorf("load ai messages: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []json.RawMessage{}
	for rows.Next() {
		var msg string
		if err := rows.Scan(&msg); err != nil {
			return nil, fmt.Errorf("scan ai message: %w", err)
		}
		out = append(out, json.RawMessage(msg))
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read ai messages: %w", err)
	}
	return out, nil
}

func (h *aiHandler) appendMessage(ctx context.Context, id, runID string, msg anthropic.BetaMessageParam) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("encode ai message: %w", err)
	}
	return h.appendRaw(ctx, id, runID, data)
}

func (h *aiHandler) appendRaw(ctx context.Context, id, runID string, data []byte) error {
	tx, err := h.store.DB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin ai message: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var status, current string
	if err := tx.QueryRowContext(ctx, `SELECT status, run_id FROM ai_conversations WHERE id = ?`, id).Scan(&status, &current); err != nil {
		return fmt.Errorf("load ai run: %w", err)
	}
	if (status != aiRunning && status != aiAwaiting) || current != runID {
		return errAIStopped
	}
	var seq int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq), 0) + 1 FROM ai_messages WHERE conversation_id = ?`, id).Scan(&seq); err != nil {
		return fmt.Errorf("next ai message: %w", err)
	}
	now := aiNow()
	if _, err := tx.ExecContext(ctx, `INSERT INTO ai_messages(conversation_id, seq, message, created_at) VALUES (?, ?, ?, ?)`, id, seq, string(data), now); err != nil {
		return fmt.Errorf("insert ai message: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE ai_conversations SET updated_at = ? WHERE id = ?`, now, id); err != nil {
		return fmt.Errorf("touch ai conversation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit ai message: %w", err)
	}
	h.pushFlush(id)
	return nil
}

func (h *aiHandler) settle(ctx context.Context, id, runID, status, message string) {
	if _, err := h.store.DB.ExecContext(ctx,
		`UPDATE ai_conversations SET status = ?, error = ?, updated_at = ? WHERE id = ? AND run_id = ? AND status = ?`,
		status, message, aiNow(), id, runID, aiRunning); err != nil {
		slog.Warn("settle ai run", "id", id, "err", err)
	}
	h.pushFlush(id)
}

func (h *aiHandler) active(ctx context.Context, id, runID string) bool {
	var status, current string
	err := h.store.DB.QueryRowContext(ctx, `SELECT status, run_id FROM ai_conversations WHERE id = ?`, id).Scan(&status, &current)
	return err == nil && status == aiRunning && current == runID
}

func (h *aiHandler) addUsage(ctx context.Context, id string, usage anthropic.BetaUsage) {
	input := usage.InputTokens + usage.CacheReadInputTokens + usage.CacheCreationInputTokens
	if _, err := h.store.DB.ExecContext(ctx,
		`UPDATE ai_conversations SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?`,
		input, usage.OutputTokens, id); err != nil {
		slog.Warn("record ai usage", "id", id, "err", err)
	}
}

func scanAIConversation(row interface{ Scan(...any) error }) (aiConversation, error) {
	var c aiConversation
	err := row.Scan(&c.ID, &c.UserID, &c.Username, &c.Title, &c.Cluster, &c.Namespace, &c.Server,
		&c.Model, &c.Effort, &c.Status, &c.Error, &c.InputTokens, &c.OutputTokens, &c.CreatedAt, &c.UpdatedAt, &c.SessionID, &c.Mode)
	return c, err
}

func aiScope(server, namespace, cluster string) (string, string, string) {
	if server == "" {
		return "", "", ""
	}
	return server, namespace, cmp.Or(cluster, scope.DefaultCluster)
}

func aiCredentials(req *http.Request) aiCreds {
	ip := middleware.GetClientIP(req.Context())
	if ip == "" {
		ip, _, _ = net.SplitHostPort(req.RemoteAddr)
	}
	u := auth.UserFromContext(req.Context())
	return aiCreds{
		cookie:     strings.Join(req.Header.Values("Cookie"), "; "),
		csrf:       req.Header.Get("X-Gameplane-CSRF"),
		remoteAddr: net.JoinHostPort(ip, "0"),
		admin:      u != nil && u.Role == rbac.RoleAdmin,
	}
}

func aiNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000000Z07:00")
}

func aiTitle(prompt string) string {
	line, _, _ := strings.Cut(prompt, "\n")
	if runes := []rune(line); len(runes) > 80 {
		return string(runes[:80]) + "…"
	}
	return line
}
