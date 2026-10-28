package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/go-chi/chi/v5"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	kubefake "k8s.io/client-go/kubernetes/fake"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/db"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
)

type aiCall struct {
	method string
	target string
	body   string
	cookie string
	csrf   string
}

type aiFixture struct {
	t       *testing.T
	h       *aiHandler
	r       chi.Router
	mu      sync.Mutex
	calls   []aiCall
	replies []string
	sendErr error
	deltas  []string
	block   chan struct{}
	params  []anthropic.BetaMessageNewParams
	routes  map[string]func() (int, string)
}

func newAIFixture(t *testing.T, enabled bool) *aiFixture {
	t.Helper()
	name := strings.NewReplacer("/", "_", " ", "_").Replace(t.Name())
	store, err := db.Open(context.Background(), "sqlite", "file:ai_"+name+"?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	cfg, _ := json.Marshal(aiSettings{Enabled: enabled})
	if _, err := store.DB.ExecContext(context.Background(), `INSERT INTO config(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, aiConfigSection, string(cfg), db.NowTimestamp()); err != nil {
		t.Fatalf("seed config: %v", err)
	}
	f := &aiFixture{t: t, routes: map[string]func() (int, string){
		"GET /servers/lobby": func() (int, string) { return http.StatusOK, `{"metadata":{"name":"lobby"}}` },
	}}
	f.h = &aiHandler{store: store, router: http.HandlerFunc(f.serve), key: func(context.Context) (string, bool) { return "sk-test", false }, send: f.send}
	f.r = chi.NewRouter()
	f.r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			u := &auth.User{ID: 1, Username: "alice"}
			switch req.Header.Get("X-User") {
			case "bob":
				u = &auth.User{ID: 2, Username: "bob"}
			case "admin":
				u = &auth.User{ID: 3, Username: "root", Perms: map[string]map[string]map[string]struct{}{"*": {"*": {"*": {}}}}}
			}
			next.ServeHTTP(w, req.WithContext(auth.WithUser(req.Context(), u)))
		})
	})
	f.h.mount(f.r)
	return f
}

func (f *aiFixture) serve(w http.ResponseWriter, req *http.Request) {
	body, _ := io.ReadAll(req.Body)
	f.mu.Lock()
	f.calls = append(f.calls, aiCall{method: req.Method, target: req.URL.String(), body: string(body), cookie: req.Header.Get("Cookie"), csrf: req.Header.Get("X-Gameplane-CSRF")})
	route := f.routes[req.Method+" "+req.URL.Path]
	f.mu.Unlock()
	if route == nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	status, out := route()
	w.WriteHeader(status)
	_, _ = w.Write([]byte(out))
}

func (f *aiFixture) send(_ context.Context, key string, params anthropic.BetaMessageNewParams, onText func(string)) (*anthropic.BetaMessage, error) {
	if key != "sk-test" {
		f.t.Errorf("send key = %q", key)
	}
	f.mu.Lock()
	block, deltas := f.block, f.deltas
	f.mu.Unlock()
	for _, delta := range deltas {
		onText(delta)
	}
	if block != nil {
		<-block
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.params = append(f.params, params)
	if f.sendErr != nil {
		return nil, f.sendErr
	}
	if len(f.replies) == 0 {
		return nil, errors.New("no scripted reply")
	}
	raw := f.replies[0]
	f.replies = f.replies[1:]
	var msg anthropic.BetaMessage
	if err := json.Unmarshal([]byte(raw), &msg); err != nil {
		return nil, fmt.Errorf("decode scripted reply: %w", err)
	}
	return &msg, nil
}

func (f *aiFixture) script(err error, replies ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sendErr, f.replies = err, replies
}

func (f *aiFixture) waitSends(n int) {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		done := len(f.params) >= n
		f.mu.Unlock()
		if done {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (f *aiFixture) do(method, path, user string, body any) *httptest.ResponseRecorder {
	f.t.Helper()
	var reader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reader = bytes.NewReader(data)
	}
	req := httptest.NewRequestWithContext(f.t.Context(), method, path, reader)
	req.Header.Set("Cookie", "gameplane_session=s1")
	req.Header.Set("X-Gameplane-CSRF", "c1")
	if user != "" {
		req.Header.Set("X-User", user)
	}
	rr := httptest.NewRecorder()
	f.r.ServeHTTP(rr, req)
	return rr
}

func (f *aiFixture) create(body map[string]any) aiConversation {
	f.t.Helper()
	rr := f.do(http.MethodPost, "/ai/conversations", "", body)
	if rr.Code != http.StatusCreated {
		f.t.Fatalf("create = %d %s", rr.Code, rr.Body.String())
	}
	var conv aiConversation
	_ = json.Unmarshal(rr.Body.Bytes(), &conv)
	return conv
}

func (f *aiFixture) wait(id, want string) aiConversation {
	f.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		conv, err := scanAIConversation(f.h.store.DB.QueryRowContext(context.Background(), aiGetOne, id))
		if err == nil && conv.Status == want {
			return conv
		}
		if time.Now().After(deadline) {
			f.t.Fatalf("status = %q (%q), want %q", conv.Status, conv.Error, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (f *aiFixture) waitStream(id string) string {
	f.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.h.streamMu.Lock()
		text := ""
		if s := f.h.streams[id]; s != nil {
			text = s.text
		}
		f.h.streamMu.Unlock()
		if text != "" || time.Now().After(deadline) {
			return text
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (f *aiFixture) detail(id, user string) (aiConversation, []json.RawMessage, []map[string]string) {
	f.t.Helper()
	rr := f.do(http.MethodGet, "/ai/conversations/"+id, user, nil)
	if rr.Code != http.StatusOK {
		f.t.Fatalf("get = %d %s", rr.Code, rr.Body.String())
	}
	var out struct {
		Conversation aiConversation      `json:"conversation"`
		Messages     []json.RawMessage   `json:"messages"`
		Pending      []map[string]string `json:"pending"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	return out.Conversation, out.Messages, out.Pending
}

func toolReply(id, input string) string {
	return `{"id":"m-` + id + `","type":"message","role":"assistant","model":"claude-opus-5-5","content":[{"type":"tool_use","id":"` + id + `","name":"gameplane_api","input":` + input + `}],"stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":5}}`
}

func textReply(text, stop string) string {
	return `{"id":"m-text","type":"message","role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":"` + text + `"}],"stop_reason":"` + stop + `","usage":{"input_tokens":7,"output_tokens":3}}`
}

func TestValidateAI(t *testing.T) {
	out, err := validateAI([]byte(`{"enabled":true,"extra":1}`))
	if err != nil || string(out) != `{"enabled":true,"defaultModel":"claude-opus-5-5","defaultEffort":"medium","defaultMode":"default","apiKeySet":false}` {
		t.Fatalf("defaults = %s, %v", out, err)
	}
	for _, body := range []string{`{`, `{"defaultModel":"gpt"}`, `{"defaultEffort":"extreme"}`, `{"defaultMode":"yolo"}`} {
		if _, err := validateAI([]byte(body)); err == nil {
			t.Errorf("validateAI(%s) accepted", body)
		}
	}
}

func TestAIAuthorizeGeneral(t *testing.T) {
	h := &aiHandler{}
	conv := aiConversation{}
	cases := []struct {
		method, path string
		query        map[string]string
		want         string
	}{
		{"GET", "/fleet/servers", nil, "/fleet/servers"},
		{"POST", "/servers/a:restart", map[string]string{"namespace": "g"}, "/servers/a:restart?namespace=g"},
		{"DELETE", "/backups/b", nil, "/backups/b"},
		{"GET", "/users/me", nil, "/users/me"},
		{"GET", "/templates/paper", nil, "/templates/paper"},
		{"POST", "/templates", nil, ""},
		{"GET", "/admin/config", nil, ""},
		{"GET", "/users", nil, ""},
		{"POST", "/cluster/kubeconfig", nil, ""},
		{"GET", "/servers/a:tunnel-credentials", nil, ""},
		{"POST", "/servers/a:transfer", nil, ""},
		{"POST", "/servers/a:shares", nil, ""},
		{"GET", "/servers/a:shares", nil, ""},
		{"GET", "/servers/a/files/download", nil, ""},
		{"GET", "/servers/a/../../admin", nil, ""},
		{"GET", "/servers/a?x=1", nil, ""},
		{"GET", "servers", nil, ""},
		{"TRACE", "/servers", nil, ""},
	}
	for _, c := range cases {
		got, err := h.authorize(t.Context(), conv, aiCreds{}, c.method, aiToolInput{Method: c.method, Path: c.path, Query: c.query})
		if c.want == "" && err == nil {
			t.Errorf("%s %s allowed as %q", c.method, c.path, got)
		}
		if c.want != "" && (err != nil || got != c.want) {
			t.Errorf("%s %s = %q, %v; want %q", c.method, c.path, got, err, c.want)
		}
	}
}

func TestAIAuthorizeServerScope(t *testing.T) {
	f := newAIFixture(t, true)
	f.routes["GET /backups/own"] = func() (int, string) { return http.StatusOK, `{"spec":{"serverRef":{"name":"lobby"}}}` }
	f.routes["GET /backups/other"] = func() (int, string) { return http.StatusOK, `{"spec":{"serverRef":{"name":"survival"}}}` }
	conv := aiConversation{Server: "lobby", Namespace: "games", Cluster: "local"}
	cases := []struct {
		method, path string
		body         string
		want         string
	}{
		{"GET", "/servers/lobby/files/read", "", "/servers/lobby/files/read?cluster=local&namespace=games"},
		{"POST", "/servers/lobby:restart", "", "/servers/lobby:restart?cluster=local&namespace=games"},
		{"GET", "/templates/paper", "", "/templates/paper?cluster=local&namespace=games"},
		{"GET", "/backups", "", "/backups?cluster=local&namespace=games"},
		{"POST", "/backups", `{"spec":{"serverRef":{"name":"lobby"}}}`, "/backups?cluster=local&namespace=games"},
		{"DELETE", "/backups/own", "", "/backups/own?cluster=local&namespace=games"},
		{"PUT", "/backups/own", `{"spec":{"serverRef":{"name":"lobby"}}}`, "/backups/own?cluster=local&namespace=games"},
		{"PUT", "/backups/own", `{"spec":{"serverRef":{"name":"survival"}}}`, ""},
		{"DELETE", "/backups/other", "", ""},
		{"DELETE", "/backups/missing", "", ""},
		{"POST", "/backups", `{"spec":{"serverRef":{"name":"survival"}}}`, ""},
		{"GET", "/backups/own/extra", "", ""},
		{"GET", "/servers/survival", "", ""},
		{"POST", "/servers/lobby:shares", "", ""},
		{"GET", "/servers", "", ""},
		{"GET", "/fleet/servers", "", ""},
	}
	for _, c := range cases {
		in := aiToolInput{Method: c.method, Path: c.path, Query: map[string]string{"namespace": "evil"}}
		if c.body != "" {
			in.Body = json.RawMessage(c.body)
		}
		got, err := f.h.authorize(t.Context(), conv, aiCreds{}, c.method, in)
		if c.want == "" && err == nil {
			t.Errorf("%s %s allowed as %q", c.method, c.path, got)
		}
		if c.want != "" && (err != nil || got != c.want) {
			t.Errorf("%s %s = %q, %v; want %q", c.method, c.path, got, err, c.want)
		}
	}
}

func TestAIHelpers(t *testing.T) {
	if got := string(aiFilterItems([]byte(`{"items":[{"spec":{"serverRef":{"name":"a"}}},{"spec":{"serverRef":{"name":"b"}}}]}`), "a")); got != `{"items":[{"spec":{"serverRef":{"name":"a"}}}]}` {
		t.Errorf("filter = %s", got)
	}
	if got := string(aiFilterItems([]byte(`nope`), "a")); got != `{"items":[]}` {
		t.Errorf("filter invalid = %s", got)
	}
	if got := aiResultText([]byte{0xff, 0xfe}); !strings.Contains(got, "binary") {
		t.Errorf("binary = %q", got)
	}
	if got := aiResultText(bytes.Repeat([]byte("a"), 50005)); got != strings.Repeat("a", 50005) {
		t.Errorf("long result = %d bytes", len(got))
	}
	if body, ct := aiBody(json.RawMessage(`"motd=hi"`)); string(body) != "motd=hi" || ct != "application/octet-stream" {
		t.Errorf("text body = %q %q", body, ct)
	}
	if body, ct := aiBody(json.RawMessage(`{"a":1}`)); string(body) != `{"a":1}` || ct != "application/json" {
		t.Errorf("json body = %q %q", body, ct)
	}
	if body, ct := aiBody(nil); body != nil || ct != "" {
		t.Errorf("empty body = %q %q", body, ct)
	}
	if got := aiTitle(strings.Repeat("ü", 90) + "\nsecond"); got != strings.Repeat("ü", 80)+"…" {
		t.Errorf("title = %q", got)
	}
	if aiServerName("/servers/a:start") != "a" || aiServerName("/servers/a/files") != "a" || aiServerName("/servers/a") != "a" || aiServerName("/backups/a") != "" {
		t.Error("aiServerName")
	}
	for _, c := range []struct {
		in   aiToolInput
		want bool
	}{
		{aiToolInput{Method: "delete", Path: "/backups/a"}, true},
		{aiToolInput{Method: "POST", Path: "/servers/a:wipe-data"}, true},
		{aiToolInput{Method: "POST", Path: "/restores"}, true},
		{aiToolInput{Method: "POST", Path: "/servers/a:restart"}, false},
	} {
		if c.in.needsApproval() != c.want {
			t.Errorf("needsApproval(%+v) != %v", c.in, c.want)
		}
	}
	if aiErrorText(errors.New("boom")) != "The Claude API could not be reached." {
		t.Error("aiErrorText plain")
	}
	if got := aiErrorText(fmt.Errorf("wrap: %w", &anthropic.Error{StatusCode: 401})); !strings.Contains(got, "401") {
		t.Errorf("aiErrorText api = %q", got)
	}
	if uses := aiToolUses([]json.RawMessage{json.RawMessage(`{"role":"user","content":[]}`)}); uses != nil {
		t.Error("tool uses from user message")
	}
	if !strings.Contains(aiSystemPrompt(aiConversation{Server: "lobby", Namespace: "g", Cluster: "local"}), `server "lobby"`) {
		t.Error("server scope missing from prompt")
	}
}

func TestAIParams(t *testing.T) {
	p := aiParams(aiConversation{Model: "claude-opus-5-5", Effort: "high"}, nil)
	if len(p.Betas) != 1 || p.OutputConfig.Effort != "high" || len(p.Tools) != len(aiTools) {
		t.Errorf("opus params = %+v", p)
	}
	if p := aiParams(aiConversation{Model: "claude-haiku-5-5", Effort: "low"}, nil); len(p.Betas) != 0 {
		t.Errorf("haiku betas = %v", p.Betas)
	}
}

func TestAIStatusAndGuards(t *testing.T) {
	f := newAIFixture(t, false)
	rr := f.do(http.MethodGet, "/ai/status", "", nil)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"enabled":false`) || !strings.Contains(rr.Body.String(), `"configured":true`) || !strings.Contains(rr.Body.String(), `"defaultMode":"default"`) {
		t.Fatalf("status = %d %s", rr.Code, rr.Body.String())
	}
	if rr := f.do(http.MethodPost, "/ai/conversations", "", map[string]any{"prompt": "hi"}); rr.Code != http.StatusForbidden {
		t.Errorf("disabled create = %d", rr.Code)
	}
	f = newAIFixture(t, true)
	f.h.key = func(context.Context) (string, bool) { return "", false }
	if rr := f.do(http.MethodPost, "/ai/conversations", "", map[string]any{"prompt": "hi"}); rr.Code != http.StatusServiceUnavailable {
		t.Errorf("no key create = %d", rr.Code)
	}
	f.h.key = func(context.Context) (string, bool) { return "sk-test", false }
	for _, body := range []map[string]any{
		{"prompt": ""},
		{"prompt": "hi", "model": "gpt"},
		{"prompt": "hi", "mode": "yolo"},
		{"prompt": "hi", "server": "Bad_Name", "namespace": "g"},
		{"prompt": "hi", "server": "lobby"},
	} {
		if rr := f.do(http.MethodPost, "/ai/conversations", "", body); rr.Code != http.StatusBadRequest {
			t.Errorf("create %v = %d", body, rr.Code)
		}
	}
	if rr := f.do(http.MethodPost, "/ai/conversations", "", map[string]any{"prompt": "hi", "server": "survival", "namespace": "g"}); rr.Code != http.StatusNotFound {
		t.Errorf("unreadable server = %d", rr.Code)
	}
	if rr := f.do(http.MethodGet, "/ai/conversations?scope=all", "", nil); rr.Code != http.StatusForbidden {
		t.Errorf("scope=all without audit:read = %d", rr.Code)
	}
	if rr := f.do(http.MethodGet, "/ai/conversations/nope", "", nil); rr.Code != http.StatusNotFound {
		t.Errorf("missing conversation = %d", rr.Code)
	}
	if rr := f.do(http.MethodPost, "/ai/conversations", "", "bad"); rr.Code != http.StatusBadRequest {
		t.Errorf("invalid json = %d", rr.Code)
	}
}

func TestAIRunServerConversation(t *testing.T) {
	f := newAIFixture(t, true)
	f.routes["GET /servers/lobby/files/read"] = func() (int, string) { return http.StatusOK, "motd: old" }
	f.script(nil,
		toolReply("t1", `{"method":"GET","path":"/servers/lobby/files/read","query":{"path":"/config.yml","namespace":"evil"}}`),
		textReply("Done", "end_turn"),
	)
	conv := f.create(map[string]any{"prompt": "Change the motd", "server": "lobby", "namespace": "games"})
	if conv.Cluster != "local" || conv.Model != "claude-opus-5-5" || conv.Effort != "medium" || conv.Title != "Change the motd" {
		t.Fatalf("conversation = %+v", conv)
	}
	done := f.wait(conv.ID, aiIdle)
	if done.InputTokens != 17 || done.OutputTokens != 8 {
		t.Errorf("usage = %d/%d", done.InputTokens, done.OutputTokens)
	}
	f.mu.Lock()
	last := f.calls[len(f.calls)-1]
	f.mu.Unlock()
	if last.target != "/servers/lobby/files/read?cluster=local&namespace=games&path=%2Fconfig.yml" || last.cookie != "gameplane_session=s1" || last.csrf != "c1" {
		t.Errorf("tool call = %+v", last)
	}
	_, msgs, _ := f.detail(conv.ID, "")
	if len(msgs) != 4 || !strings.Contains(string(msgs[2]), "motd: old") {
		t.Fatalf("messages = %s", msgs)
	}
	rr := f.do(http.MethodGet, "/ai/conversations?server=lobby&namespace=games", "", nil)
	if !strings.Contains(rr.Body.String(), conv.ID) {
		t.Errorf("list = %s", rr.Body.String())
	}
	if rr := f.do(http.MethodGet, "/ai/conversations", "", nil); strings.Contains(rr.Body.String(), conv.ID) {
		t.Errorf("general list leaked server conversation")
	}
	if rr := f.do(http.MethodGet, "/ai/conversations/"+conv.ID, "bob", nil); rr.Code != http.StatusNotFound {
		t.Errorf("other user read = %d", rr.Code)
	}
	f.detail(conv.ID, "admin")
	if !strings.Contains(f.do(http.MethodGet, "/ai/conversations?scope=all", "admin", nil).Body.String(), conv.ID) {
		t.Errorf("admin list missing conversation")
	}
	f.script(nil, textReply("Again", "end_turn"))
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/messages", "", map[string]any{"prompt": "thanks"}); rr.Code != http.StatusOK {
		t.Fatalf("follow-up = %d %s", rr.Code, rr.Body.String())
	}
	f.wait(conv.ID, aiIdle)
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/messages", "bob", map[string]any{"prompt": "hi"}); rr.Code != http.StatusNotFound {
		t.Errorf("other user post = %d", rr.Code)
	}
}

func TestAIRunApproval(t *testing.T) {
	f := newAIFixture(t, true)
	f.routes["GET /backups/b1"] = func() (int, string) { return http.StatusOK, `{"spec":{"serverRef":{"name":"lobby"}}}` }
	f.routes["DELETE /backups/b1"] = func() (int, string) { return http.StatusForbidden, "forbidden" }
	f.script(nil, toolReply("t1", `{"method":"DELETE","path":"/backups/b1"}`))
	conv := f.create(map[string]any{"prompt": "delete backup b1", "server": "lobby", "namespace": "games"})
	f.wait(conv.ID, aiAwaiting)
	_, _, pending := f.detail(conv.ID, "")
	if len(pending) != 1 || pending[0]["method"] != "DELETE" || pending[0]["path"] != "/backups/b1" {
		t.Fatalf("pending = %v", pending)
	}
	f.script(nil, textReply("Not deleted", "end_turn"))
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/approval", "", map[string]any{"approve": false}); rr.Code != http.StatusOK {
		t.Fatalf("decline = %d %s", rr.Code, rr.Body.String())
	}
	f.wait(conv.ID, aiIdle)
	f.mu.Lock()
	for _, c := range f.calls {
		if c.method == http.MethodDelete {
			t.Errorf("declined delete reached the API: %+v", c)
		}
	}
	f.mu.Unlock()
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/approval", "", map[string]any{"approve": true}); rr.Code != http.StatusConflict {
		t.Errorf("approval when idle = %d", rr.Code)
	}
	f.script(nil, toolReply("t2", `{"method":"DELETE","path":"/backups/b1"}`), textReply("You may not delete backups", "end_turn"))
	f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/messages", "", map[string]any{"prompt": "really delete it"})
	f.wait(conv.ID, aiAwaiting)
	f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/approval", "", map[string]any{"approve": true})
	f.wait(conv.ID, aiIdle)
	_, msgs, _ := f.detail(conv.ID, "")
	if !strings.Contains(string(msgs[len(msgs)-2]), "HTTP 403") {
		t.Errorf("forbidden delete result = %s", msgs[len(msgs)-2])
	}
}

func TestAIRunBypass(t *testing.T) {
	f := newAIFixture(t, true)
	f.routes["GET /backups/b1"] = func() (int, string) { return http.StatusOK, `{"spec":{"serverRef":{"name":"lobby"}}}` }
	f.routes["DELETE /backups/b1"] = func() (int, string) { return http.StatusOK, `{}` }
	f.script(nil, toolReply("t1", `{"method":"DELETE","path":"/backups/b1"}`), textReply("Deleted", "end_turn"))
	conv := f.create(map[string]any{"prompt": "delete backup b1", "server": "lobby", "namespace": "games", "mode": aiModeBypass})
	if conv.Mode != aiModeBypass {
		t.Fatalf("mode = %q", conv.Mode)
	}
	f.wait(conv.ID, aiIdle)
	f.mu.Lock()
	deleted := slices.ContainsFunc(f.calls, func(c aiCall) bool { return c.method == http.MethodDelete })
	system := f.params[0].System[0].Text
	f.mu.Unlock()
	if !deleted || !strings.Contains(system, "Bypass permissions is on") {
		t.Errorf("deleted=%v system=%q", deleted, system)
	}
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/messages", "", map[string]any{"prompt": "again", "mode": "yolo"}); rr.Code != http.StatusBadRequest {
		t.Errorf("bad mode post = %d", rr.Code)
	}
	f.script(nil, toolReply("t2", `{"method":"DELETE","path":"/backups/b1"}`))
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/messages", "", map[string]any{"prompt": "delete it again", "mode": aiModeDefault}); rr.Code != http.StatusOK {
		t.Fatalf("follow-up = %d %s", rr.Code, rr.Body.String())
	}
	if got := f.wait(conv.ID, aiAwaiting); got.Mode != aiModeDefault {
		t.Errorf("mode after follow-up = %q", got.Mode)
	}
}

func TestAIRunCancelAndFailures(t *testing.T) {
	f := newAIFixture(t, true)
	f.block = make(chan struct{})
	f.script(nil, toolReply("t1", `{"method":"GET","path":"/servers/lobby"}`))
	conv := f.create(map[string]any{"prompt": "look"})
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/messages", "", map[string]any{"prompt": "again"}); rr.Code != http.StatusConflict {
		t.Errorf("post while running = %d", rr.Code)
	}
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/cancel", "", nil); rr.Code != http.StatusNoContent {
		t.Fatalf("cancel = %d", rr.Code)
	}
	f.mu.Lock()
	close(f.block)
	f.block = nil
	f.mu.Unlock()
	f.waitSends(1)
	stopped := f.wait(conv.ID, aiIdle)
	if stopped.Error != "Stopped by the user." {
		t.Errorf("cancel error = %q", stopped.Error)
	}
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/cancel", "", nil); rr.Code != http.StatusConflict {
		t.Errorf("cancel idle = %d", rr.Code)
	}
	f.script(nil, toolReply("t2", `{"method":"DELETE","path":"/backups/old"}`))
	f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/messages", "", map[string]any{"prompt": "clean up"})
	f.wait(conv.ID, aiAwaiting)
	if rr := f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/cancel", "", nil); rr.Code != http.StatusNoContent {
		t.Fatalf("cancel awaiting = %d", rr.Code)
	}
	f.script(nil, textReply("no", "refusal"))
	f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/messages", "", map[string]any{"prompt": "go on"})
	if got := f.wait(conv.ID, aiFailed); got.Error != "Claude declined this request." {
		t.Errorf("refusal error = %q", got.Error)
	}
	f.mu.Lock()
	data, _ := json.Marshal(f.params[len(f.params)-1].Messages)
	f.mu.Unlock()
	if !strings.Contains(string(data), "Interrupted") {
		t.Errorf("cancelled tool use was not closed: %s", data)
	}
	f.script(errors.New("network down"))
	f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/messages", "", map[string]any{"prompt": "retry"})
	if got := f.wait(conv.ID, aiFailed); got.Error != "The Claude API could not be reached." {
		t.Errorf("send error = %q", got.Error)
	}
	f.script(nil, textReply("long", "max_tokens"))
	f.do(http.MethodPost, "/ai/conversations/"+conv.ID+"/messages", "", map[string]any{"prompt": "more"})
	if got := f.wait(conv.ID, aiFailed); !strings.Contains(got.Error, "length limit") {
		t.Errorf("max tokens error = %q", got.Error)
	}
	if _, err := f.h.store.DB.ExecContext(context.Background(), `UPDATE ai_conversations SET status = ? WHERE id = ?`, aiRunning, conv.ID); err != nil {
		t.Fatal(err)
	}
	f.h.mount(chi.NewRouter())
	if got := f.wait(conv.ID, aiFailed); got.Error != "Interrupted by an API restart." {
		t.Errorf("restart reset = %q", got.Error)
	}
}

func TestAISecret(t *testing.T) {
	k := &kube.Client{Typed: kubefake.NewClientset(&corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "other", Namespace: notifNS},
	})}
	f := newAIFixture(t, true)
	MountAISecret(f.r, k, notifNS)
	key := AIKeyReader(k, notifNS)
	if got, _ := key(t.Context()); got != "" {
		t.Error("key before put")
	}
	if rr := f.do(http.MethodPut, "/admin/ai/secret", "", map[string]string{"apiKey": " "}); rr.Code != http.StatusUnprocessableEntity {
		t.Errorf("empty key = %d", rr.Code)
	}
	if rr := f.do(http.MethodPut, "/admin/ai/secret", "", "bad"); rr.Code != http.StatusBadRequest {
		t.Errorf("invalid json = %d", rr.Code)
	}
	if rr := f.do(http.MethodPut, "/admin/ai/secret", "", map[string]string{"apiKey": "sk-live"}); rr.Code != http.StatusOK || strings.Contains(rr.Body.String(), "sk-live") {
		t.Fatalf("put = %d %s", rr.Code, rr.Body.String())
	}
	syncSecretData(t, k, notifNS, aiSecretName)
	if got, sub := key(t.Context()); got != "sk-live" || sub {
		t.Errorf("key = %q", got)
	}
	if rr := f.do(http.MethodDelete, "/admin/ai/secret", "", nil); rr.Code != http.StatusNoContent {
		t.Errorf("delete = %d", rr.Code)
	}
	if rr := f.do(http.MethodDelete, "/admin/ai/secret", "", nil); rr.Code != http.StatusNotFound {
		t.Errorf("second delete = %d", rr.Code)
	}
	if _, err := k.Typed.CoreV1().Secrets(notifNS).Create(t.Context(), &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: aiSecretName, Namespace: notifNS}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	if rr := f.do(http.MethodPut, "/admin/ai/secret", "", map[string]string{"apiKey": "sk"}); rr.Code != http.StatusConflict {
		t.Errorf("unmanaged secret = %d", rr.Code)
	}
}
