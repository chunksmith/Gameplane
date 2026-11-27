//go:build envtest

package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	kubefake "k8s.io/client-go/kubernetes/fake"

	"github.com/GameplanePanel/gameplane/api/internal/db"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
)

type linearCall struct {
	name string
	args string
}

type linearCalls struct {
	mu    sync.Mutex
	calls []linearCall
}

func (c *linearCalls) record(name string, args json.RawMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, linearCall{name: name, args: string(args)})
}

func (c *linearCalls) args(name string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, call := range c.calls {
		if call.name == name {
			out = append(out, call.args)
		}
	}
	return out
}

func fakeLinearDial(calls *linearCalls) func(context.Context, string) (*mcp.ClientSession, error) {
	replies := map[string]string{
		"list_issues":         `{"issues":[{"id":"CHK-142","title":"Login fails","status":"In Review","statusType":"started","priority":{"value":2,"name":"High"},"project":"Ardiy","projectId":"p1","assignee":"Arda","updatedAt":"2026-11-22T11:30:59Z","url":"https://linear.app/chunksmith/issue/CHK-142/login","team":"Checkout","teamId":"t1"}],"hasNextPage":false,"cursor":null}`,
		"get_issue":           `{"id":"CHK-142","title":"Login fails","status":"Todo","statusType":"unstarted","priority":{"value":0,"name":"No priority"},"project":null,"projectId":null,"assignee":null,"updatedAt":"2026-11-22T11:30:59Z","url":"https://linear.app/chunksmith/issue/CHK-142/login","team":"Checkout","teamId":"t1","description":"Steps","labels":[{"name":"bug"}],"createdBy":"Arda","createdAt":"2026-11-20T10:00:00Z"}`,
		"list_comments":       `{"comments":[{"id":"c1","body":"hi","createdAt":"2026-11-21T00:00:00Z","author":{"displayName":"Arda"}}],"hasNextPage":false}`,
		"list_issue_statuses": `[{"id":"s-review","type":"started","name":"In Review"},{"id":"s-done","type":"completed","name":"Done"},{"id":"s-progress","type":"started","name":"In Progress"},{"id":"s-todo","type":"unstarted","name":"Todo"}]`,
		"save_issue":          `{"id":"CHK-142"}`,
		"list_teams":          `{"teams":[{"id":"t1","key":"CHK","name":"Checkout"}]}`,
		"list_projects":       `{"projects":[{"id":"p1","name":"Ardiy"}]}`,
	}
	return func(ctx context.Context, _ string) (*mcp.ClientSession, error) {
		server := mcp.NewServer(&mcp.Implementation{Name: "linear", Version: "1"}, nil)
		for name, text := range replies {
			server.AddTool(&mcp.Tool{Name: name, Description: name, InputSchema: map[string]any{"type": "object"}}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				calls.record(name, req.Params.Arguments)
				return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}, nil
			})
		}
		serverTransport, clientTransport := mcp.NewInMemoryTransports()
		if _, err := server.Connect(ctx, serverTransport, nil); err != nil {
			return nil, err
		}
		return mcp.NewClient(&mcp.Implementation{Name: "gameplane", Version: "1"}, nil).Connect(ctx, clientTransport, nil)
	}
}

func linearFixture(t *testing.T) (*aiFixture, *linearCalls) {
	t.Helper()
	f := newAIFixture(t, true)
	cfg, _ := json.Marshal(aiSettings{Enabled: true, LinearEnabled: true})
	if _, err := f.h.store.DB.ExecContext(context.Background(), `INSERT INTO config(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, aiConfigSection, string(cfg), db.NowTimestamp()); err != nil {
		t.Fatalf("enable linear: %v", err)
	}
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: aiLinearSecret + "-1", Namespace: notifNS, Labels: map[string]string{aiSecretLabel: "true"}},
		Data:       map[string][]byte{"apiKey": []byte("lin_test")},
	}
	f.h.linearKeys = AILinearKeys{k: &kube.Client{Typed: kubefake.NewClientset(secret)}, ns: notifNS}
	calls := &linearCalls{}
	f.h.dialLinear = fakeLinearDial(calls)
	f.routes["GET /repositories/lithomes"] = func() (int, string) { return http.StatusOK, `{}` }
	return f, calls
}

func TestAILinearSolve(t *testing.T) {
	f, calls := linearFixture(t)
	f.script(nil, textReply("Fixed it", "end_turn"))
	rr := f.do(http.MethodPost, "/ai/linear/issues/chk-142/solve", "", map[string]any{"repository": "lithomes", "namespace": "gameplane-games", "message": "Fix the login bug"})
	if rr.Code != http.StatusCreated {
		t.Fatalf("solve = %d %s", rr.Code, rr.Body.String())
	}
	var out struct {
		Conversation aiConversation `json:"conversation"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode solve: %v", err)
	}
	if out.Conversation.LinearIssue != "CHK-142" {
		t.Fatalf("linearIssue = %q", out.Conversation.LinearIssue)
	}
	if states := calls.args("save_issue"); len(states) != 1 || !strings.Contains(states[0], `"state":"s-progress"`) {
		t.Fatalf("save_issue calls = %v", states)
	}
	f.wait(out.Conversation.ID, aiIdle)
	stored, msgs, _ := f.detail(out.Conversation.ID, "")
	if stored.LinearIssue != "CHK-142" || len(msgs) == 0 || !strings.Contains(string(msgs[0]), "@linear CHK-142") {
		t.Fatalf("stored = %+v first message = %s", stored, msgs)
	}
}

func TestAILinearSolveRepositoryMissing(t *testing.T) {
	f, calls := linearFixture(t)
	rr := f.do(http.MethodPost, "/ai/linear/issues/CHK-142/solve", "", map[string]any{"repository": "nope", "namespace": "gameplane-games"})
	if rr.Code != http.StatusNotFound {
		t.Fatalf("solve = %d %s", rr.Code, rr.Body.String())
	}
	if len(calls.args("save_issue")) != 0 {
		t.Fatalf("save_issue called for a missing repository")
	}
}

func TestAILinearSolveWithoutKey(t *testing.T) {
	f, _ := linearFixture(t)
	rr := f.do(http.MethodPost, "/ai/linear/issues/CHK-142/solve", "bob", map[string]any{"repository": "lithomes", "namespace": "gameplane-games"})
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("solve without key = %d %s", rr.Code, rr.Body.String())
	}
}

func TestAILinearIssuesViews(t *testing.T) {
	f, calls := linearFixture(t)
	f.script(nil, textReply("Fixed it", "end_turn"))
	rr := f.do(http.MethodPost, "/ai/linear/issues/CHK-142/solve", "", map[string]any{"repository": "lithomes", "namespace": "gameplane-games"})
	if rr.Code != http.StatusCreated {
		t.Fatalf("solve = %d %s", rr.Code, rr.Body.String())
	}
	var solved struct {
		Conversation aiConversation `json:"conversation"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &solved)
	f.wait(solved.Conversation.ID, aiIdle)

	rr = f.do(http.MethodGet, "/ai/linear/issues?view=mine", "", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("mine = %d %s", rr.Code, rr.Body.String())
	}
	var page struct {
		Issues []aiLinearListIssue `json:"issues"`
		Cursor *string             `json:"cursor"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &page)
	if len(page.Issues) != 1 || page.Issues[0].Run == nil || page.Issues[0].Run.Conversation != solved.Conversation.ID || page.Cursor != nil {
		t.Fatalf("mine page = %s", rr.Body.String())
	}
	if args := calls.args("list_issues"); len(args) == 0 || !strings.Contains(args[len(args)-1], `"assignee":"me"`) {
		t.Fatalf("list_issues args = %v", args)
	}

	rr = f.do(http.MethodGet, "/ai/linear/issues?view=runs", "", nil)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"CHK-142"`) {
		t.Fatalf("runs = %d %s", rr.Code, rr.Body.String())
	}

	rr = f.do(http.MethodGet, "/ai/linear/issues", "", nil)
	var legacy []aiLinearIssue
	if rr.Code != http.StatusOK || json.Unmarshal(rr.Body.Bytes(), &legacy) != nil || len(legacy) != 1 || legacy[0].ID != "CHK-142" {
		t.Fatalf("legacy list = %d %s", rr.Code, rr.Body.String())
	}

	rr = f.do(http.MethodGet, "/ai/linear/issues/CHK-142", "", nil)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"bug"`) || !strings.Contains(rr.Body.String(), `"Arda"`) {
		t.Fatalf("issue detail = %d %s", rr.Code, rr.Body.String())
	}
}

func TestAILinearLinks(t *testing.T) {
	f, _ := linearFixture(t)
	links := []aiLinearLink{{ProjectID: "p1", ProjectName: "Ardiy", Repository: "lithomes", Namespace: "gameplane-games"}}
	rr := f.do(http.MethodPut, "/ai/linear/links", "", links)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"projectId":"p1"`) {
		t.Fatalf("put links = %d %s", rr.Code, rr.Body.String())
	}
	rr = f.do(http.MethodGet, "/ai/linear/links", "", nil)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"repository":"lithomes"`) {
		t.Fatalf("get links = %d %s", rr.Code, rr.Body.String())
	}
	bad := []aiLinearLink{{ProjectID: "p1", ProjectName: "Ardiy", Repository: "Bad_Name", Namespace: "gameplane-games"}}
	if rr = f.do(http.MethodPut, "/ai/linear/links", "", bad); rr.Code != http.StatusBadRequest {
		t.Fatalf("bad repository = %d %s", rr.Code, rr.Body.String())
	}
}
