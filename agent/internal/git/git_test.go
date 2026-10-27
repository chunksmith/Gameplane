package git

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

const testToken = "ghp_testtoken0123456789"

func TestMain(m *testing.M) {
	if Askpass() {
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func allowAll(context.Context, string) error {
	return nil
}

func gitCmd(t *testing.T, dir string, args ...string) string {
	t.Helper()
	full := append([]string{"-c", "user.name=Tester", "-c", "user.email=tester@example.com", "-c", "init.defaultBranch=main"}, args...)
	cmd := exec.CommandContext(t.Context(), "git", full...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func writeFile(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

type fixture struct {
	t      *testing.T
	url    string
	dir    string
	remote string
	h      *handler
}

func newBareRemote(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	t.Setenv("HOME", t.TempDir())
	remote := filepath.Join(t.TempDir(), "remote.git")
	gitCmd(t, filepath.Dir(remote), "init", "-q", "--bare", "-b", "main", remote)
	seed := t.TempDir()
	gitCmd(t, seed, "clone", "-q", remote, ".")
	writeFile(t, seed, "README.md", "line one\n")
	gitCmd(t, seed, "add", "README.md")
	gitCmd(t, seed, "commit", "-q", "-m", "initial")
	gitCmd(t, seed, "push", "-q", "origin", "HEAD:main")
	return remote
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	remote := newBareRemote(t)
	f := startFixture(t, remote, allowAll)
	f.cloneOK(remote)
	return f
}

func startFixture(t *testing.T, remote string, check func(context.Context, string) error) *fixture {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("eval: %v", err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("executable: %v", err)
	}
	h := newHandler(dir, self, check)
	r := chi.NewRouter()
	h.mount(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return &fixture{t: t, url: srv.URL, dir: dir, remote: remote, h: h}
}

func (f *fixture) do(method, path string, body any, headers map[string]string) (int, []byte) {
	f.t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			f.t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(f.t.Context(), method, f.url+path, reader)
	if err != nil {
		f.t.Fatalf("request: %v", err)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		f.t.Fatalf("read: %v", err)
	}
	return resp.StatusCode, data
}

func (f *fixture) expect(method, path string, body any, headers map[string]string, want int, out any) []byte {
	f.t.Helper()
	code, data := f.do(method, path, body, headers)
	if code != want {
		f.t.Fatalf("%s %s: status %d want %d: %s", method, path, code, want, data)
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			f.t.Fatalf("decode %s: %v", data, err)
		}
	}
	return data
}

func (f *fixture) expectCode(method, path string, body any, headers map[string]string, want int, code string) gitError {
	f.t.Helper()
	var out gitError
	f.expect(method, path, body, headers, want, &out)
	if out.Code != code {
		f.t.Fatalf("%s %s: code %q want %q", method, path, out.Code, code)
	}
	return out
}

func token() map[string]string {
	return map[string]string{tokenHeader: testToken}
}

func author() map[string]string {
	return map[string]string{
		tokenHeader:       testToken,
		authorNameHeader:  "Octo Cat",
		authorEmailHeader: "42+octocat@users.noreply.github.com",
	}
}

func (f *fixture) cloneOK(remote string) {
	f.t.Helper()
	f.expect(http.MethodPost, "/git/clone", map[string]any{"url": remote}, token(), http.StatusAccepted, nil)
	if state := f.waitClone(); state.State != cloneDone {
		f.t.Fatalf("clone state %+v", state)
	}
}

func (f *fixture) waitClone() cloneState {
	f.t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var state cloneState
		f.expect(http.MethodGet, "/git/clone", nil, nil, http.StatusOK, &state)
		if state.State != cloneRun {
			if state.State == cloneFault {
				return state
			}
			if f.h.mu.TryLock() {
				f.h.mu.Unlock()
				return state
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	f.t.Fatal("clone did not finish")
	return cloneState{}
}

func (f *fixture) status() status {
	f.t.Helper()
	var st status
	f.expect(http.MethodGet, "/git/status", nil, nil, http.StatusOK, &st)
	return st
}

func (f *fixture) commitFile(name, body, summary string) commit {
	f.t.Helper()
	writeFile(f.t, f.dir, name, body)
	f.expect(http.MethodPost, "/git/stage", map[string]any{"paths": []string{name}}, nil, http.StatusOK, nil)
	var out struct {
		Commit commit `json:"commit"`
	}
	f.expect(http.MethodPost, "/git/commit", map[string]any{"summary": summary}, author(), http.StatusOK, &out)
	return out.Commit
}

func (f *fixture) otherClonePushes(name, body string) {
	f.t.Helper()
	other := f.t.TempDir()
	gitCmd(f.t, other, "clone", "-q", f.remote, ".")
	writeFile(f.t, other, name, body)
	gitCmd(f.t, other, "add", "-A")
	gitCmd(f.t, other, "commit", "-q", "-m", "remote change")
	gitCmd(f.t, other, "push", "-q", "origin", "HEAD:main")
}

func TestCloneStatusStageCommitPush(t *testing.T) {
	f := newFixture(t)
	if _, err := os.Stat(filepath.Join(f.dir, cloneDir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging dir left behind: %v", err)
	}
	config, err := os.ReadFile(filepath.Join(f.dir, ".git", "config"))
	if err != nil || strings.Contains(string(config), testToken) {
		t.Fatalf("token in git config or read failed: %v", err)
	}
	st := f.status()
	if st.Branch != "main" || st.Upstream == nil || *st.Upstream != "origin/main" || st.Head == nil || len(st.Changes) != 0 {
		t.Fatalf("clean status %+v", st)
	}
	writeFile(t, f.dir, "README.md", "line one\nline two\n")
	writeFile(t, f.dir, "new.txt", "hello\n")
	st = f.status()
	states := map[string]change{}
	for _, entry := range st.Changes {
		states[entry.Path] = entry
	}
	if states["README.md"].State != "M" || states["README.md"].Additions != 1 || states["new.txt"].State != "U" {
		t.Fatalf("changes %+v", st.Changes)
	}
	f.expect(http.MethodPost, "/git/stage", map[string]any{"paths": []string{"new.txt"}}, nil, http.StatusOK, &st)
	if len(st.Changes) != 2 {
		t.Fatalf("after stage %+v", st.Changes)
	}
	diff := f.expect(http.MethodGet, "/git/diff?staged=true", nil, nil, http.StatusOK, nil)
	if !strings.Contains(string(diff), "+hello") {
		t.Fatalf("staged diff %s", diff)
	}
	diff = f.expect(http.MethodGet, "/git/diff?path=README.md", nil, nil, http.StatusOK, nil)
	if !strings.Contains(string(diff), "+line two") || strings.Contains(string(diff), "hello") {
		t.Fatalf("path diff %s", diff)
	}
	var out struct {
		Commit commit `json:"commit"`
		Pushed bool   `json:"pushed"`
	}
	body := map[string]any{"summary": "Add new", "description": "details", "push": true}
	f.expect(http.MethodPost, "/git/commit", body, author(), http.StatusOK, &out)
	if !out.Pushed || !out.Commit.Pushed || out.Commit.Subject != "Add new" || out.Commit.Body != "details" ||
		out.Commit.Login == nil || *out.Commit.Login != "octocat" || out.Commit.Author != "Octo Cat" {
		t.Fatalf("commit %+v", out)
	}
	if !strings.Contains(gitCmd(t, f.dir, "--git-dir", f.remote, "log", "--format=%s", "main"), "Add new") {
		t.Fatal("commit not on remote")
	}
}

func TestUnstageDiscardUndo(t *testing.T) {
	f := newFixture(t)
	writeFile(t, f.dir, "README.md", "changed\n")
	writeFile(t, f.dir, "extra.txt", "x\n")
	var st status
	f.expect(http.MethodPost, "/git/stage", map[string]any{"paths": "all"}, nil, http.StatusOK, &st)
	for _, entry := range st.Changes {
		if !entry.Staged {
			t.Fatalf("not staged %+v", entry)
		}
	}
	f.expect(http.MethodPost, "/git/unstage", map[string]any{"paths": "all"}, nil, http.StatusOK, &st)
	for _, entry := range st.Changes {
		if entry.Staged {
			t.Fatalf("still staged %+v", entry)
		}
	}
	f.expect(http.MethodPost, "/git/discard", map[string]any{"paths": []string{"extra.txt"}}, nil, http.StatusOK, &st)
	if len(st.Changes) != 1 || st.Changes[0].Path != "README.md" {
		t.Fatalf("after discard one %+v", st.Changes)
	}
	f.expect(http.MethodPost, "/git/discard", map[string]any{"paths": "all"}, nil, http.StatusOK, &st)
	if len(st.Changes) != 0 {
		t.Fatalf("after discard all %+v", st.Changes)
	}
	f.commitFile("a.txt", "a\n", "local only")
	f.expect(http.MethodPost, "/git/undo", nil, nil, http.StatusOK, &st)
	if len(st.Changes) != 1 || !st.Changes[0].Staged || st.Ahead != 0 {
		t.Fatalf("after undo %+v", st)
	}
	f.expect(http.MethodPost, "/git/unstage", map[string]any{"paths": []string{"a.txt"}}, nil, http.StatusOK, &st)
	if len(st.Changes) != 1 || st.Changes[0].State != "U" {
		t.Fatalf("after unstage path %+v", st.Changes)
	}
	f.expectCode(http.MethodPost, "/git/undo", nil, nil, http.StatusConflict, "already_pushed")
}

func TestPullConflictAborts(t *testing.T) {
	f := newFixture(t)
	f.otherClonePushes("README.md", "remote edit\n")
	f.commitFile("README.md", "local edit\n", "local edit")
	out := f.expectCode(http.MethodPost, "/git/pull", nil, token(), http.StatusConflict, "conflict")
	if len(out.Files) != 1 || out.Files[0] != "README.md" {
		t.Fatalf("conflict files %+v", out)
	}
	if _, err := os.Stat(filepath.Join(f.dir, ".git", "rebase-merge")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rebase not aborted: %v", err)
	}
	if st := f.status(); st.Ahead != 1 || st.Behind != 1 || len(st.Changes) != 0 {
		t.Fatalf("after abort %+v", st)
	}
}

func TestPushRejectedThenPullRebase(t *testing.T) {
	f := newFixture(t)
	f.otherClonePushes("remote.txt", "r\n")
	f.commitFile("local.txt", "l\n", "local")
	writeFile(t, f.dir, "wip.txt", "uncommitted\n")
	f.expectCode(http.MethodPost, "/git/push", map[string]any{}, token(), http.StatusConflict, "push_rejected")
	var out struct {
		Commit commit `json:"commit"`
	}
	f.expect(http.MethodPost, "/git/fetch", nil, token(), http.StatusOK, nil)
	if st := f.status(); st.Behind != 1 {
		t.Fatalf("after fetch %+v", st)
	}
	st := status{}
	f.expect(http.MethodPost, "/git/pull", nil, token(), http.StatusOK, &st)
	if st.Ahead != 1 || st.Behind != 0 || len(st.Changes) != 1 {
		t.Fatalf("after pull %+v", st)
	}
	f.expect(http.MethodPost, "/git/push", map[string]any{"setUpstream": true}, token(), http.StatusOK, &st)
	if st.Ahead != 0 {
		t.Fatalf("after push %+v", st)
	}
	writeFile(t, f.dir, "wip.txt", "more\n")
	f.expect(http.MethodPost, "/git/stage", map[string]any{"paths": "all"}, nil, http.StatusOK, nil)
	f.expect(http.MethodPost, "/git/commit", map[string]any{"summary": "wip"}, author(), http.StatusOK, &out)
	if out.Commit.Pushed {
		t.Fatalf("unpushed commit marked pushed %+v", out.Commit)
	}
}

func TestCommitPushFailureKeepsCommit(t *testing.T) {
	f := newFixture(t)
	f.otherClonePushes("remote.txt", "r\n")
	writeFile(t, f.dir, "local.txt", "l\n")
	f.expect(http.MethodPost, "/git/stage", map[string]any{"paths": "all"}, nil, http.StatusOK, nil)
	out := f.expectCode(http.MethodPost, "/git/commit", map[string]any{"summary": "local", "push": true}, author(), http.StatusConflict, "push_rejected")
	if out.Commit == nil || out.Commit.Subject != "local" || out.Commit.Pushed {
		t.Fatalf("commit missing from push error %+v", out)
	}
}

func TestBranchesAndCheckout(t *testing.T) {
	f := newFixture(t)
	var created branch
	f.expect(http.MethodPost, "/git/branches", map[string]any{"name": "feature"}, nil, http.StatusOK, &created)
	if created.Name != "feature" || created.Current {
		t.Fatalf("created %+v", created)
	}
	f.expectCode(http.MethodPost, "/git/branches", map[string]any{"name": "bad..name"}, nil, http.StatusBadRequest, "bad_request")
	f.expectCode(http.MethodPost, "/git/branches", map[string]any{"name": "-x"}, nil, http.StatusBadRequest, "bad_request")
	var list []branch
	f.expect(http.MethodGet, "/git/branches", nil, nil, http.StatusOK, &list)
	names := map[string]branch{}
	for _, entry := range list {
		names[entry.Name] = entry
	}
	if !names["main"].Current || names["main"].Upstream == nil || names["origin/main"].Name == "" || names["feature"].Name == "" {
		t.Fatalf("branches %+v", list)
	}
	if _, ok := names["origin/HEAD"]; ok {
		t.Fatalf("origin/HEAD listed %+v", list)
	}
	writeFile(t, f.dir, "README.md", "dirty\n")
	f.expectCode(http.MethodPost, "/git/checkout", map[string]any{"branch": "feature"}, nil, http.StatusConflict, "dirty")
	f.expect(http.MethodPost, "/git/discard", map[string]any{"paths": "all"}, nil, http.StatusOK, nil)
	var st status
	f.expect(http.MethodPost, "/git/checkout", map[string]any{"branch": "feature"}, nil, http.StatusOK, &st)
	if st.Branch != "feature" {
		t.Fatalf("checkout %+v", st)
	}
	f.expect(http.MethodPost, "/git/checkout", map[string]any{"branch": "origin/main"}, nil, http.StatusOK, &st)
	if st.Branch != "main" {
		t.Fatalf("checkout remote %+v", st)
	}
}

func TestCheckoutRejectsOptionLikeRemoteBranch(t *testing.T) {
	f := newFixture(t)
	f.expectCode(http.MethodPost, "/git/checkout", map[string]any{"branch": "origin/--orphan=x"}, nil, http.StatusBadRequest, "bad_request")
}

func TestCreateBranchCheckoutKeepsChanges(t *testing.T) {
	f := newFixture(t)
	writeFile(t, f.dir, "README.md", "dirty\n")
	var created branch
	f.expect(http.MethodPost, "/git/branches", map[string]any{"name": "feature", "checkout": true}, nil, http.StatusOK, &created)
	if created.Name != "feature" || !created.Current {
		t.Fatalf("created %+v", created)
	}
	st := f.status()
	if st.Branch != "feature" || len(st.Changes) != 1 || st.Changes[0].Path != "README.md" {
		t.Fatalf("after create with checkout %+v", st)
	}
}

func TestStatusListsUntrackedDirectoryFiles(t *testing.T) {
	f := newFixture(t)
	if err := os.Mkdir(filepath.Join(f.dir, "newdir"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	writeFile(t, f.dir, filepath.Join("newdir", "a.txt"), "a\n")
	st := f.status()
	if len(st.Changes) != 1 || st.Changes[0].Path != "newdir/a.txt" || st.Changes[0].State != "U" {
		t.Fatalf("changes %+v", st.Changes)
	}
}

func TestLogShowRevert(t *testing.T) {
	f := newFixture(t)
	first := f.commitFile("a.txt", "a\n", "first")
	f.commitFile("b.txt", "b\n", "second")
	var page struct {
		Commits []commit `json:"commits"`
		Next    *string  `json:"next"`
	}
	f.expect(http.MethodGet, "/git/log?limit=2", nil, nil, http.StatusOK, &page)
	if len(page.Commits) != 2 || page.Commits[0].Subject != "second" || page.Next == nil || page.Commits[0].Pushed {
		t.Fatalf("page one %+v", page)
	}
	f.expect(http.MethodGet, "/git/log?limit=2&cursor="+*page.Next, nil, nil, http.StatusOK, &page)
	if len(page.Commits) != 1 || page.Commits[0].Subject != "initial" || page.Next != nil || !page.Commits[0].Pushed {
		t.Fatalf("page two %+v", page)
	}
	f.expectCode(http.MethodGet, "/git/log?ref=--all", nil, nil, http.StatusBadRequest, "bad_request")
	var shown struct {
		Commit commit `json:"commit"`
		Diff   string `json:"diff"`
	}
	f.expect(http.MethodGet, "/git/commits/"+first.SHA, nil, nil, http.StatusOK, &shown)
	if shown.Commit.SHA != first.SHA || !strings.Contains(shown.Diff, "+a") {
		t.Fatalf("show %+v", shown)
	}
	f.expectCode(http.MethodGet, "/git/commits/xyz", nil, nil, http.StatusBadRequest, "bad_request")
	var reverted struct {
		Commit commit `json:"commit"`
	}
	f.expect(http.MethodPost, "/git/revert", map[string]any{"sha": first.SHA}, author(), http.StatusOK, &reverted)
	if !strings.HasPrefix(reverted.Commit.Subject, "Revert") {
		t.Fatalf("revert %+v", reverted)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "a.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("revert kept file: %v", err)
	}
	f.expectCode(http.MethodPost, "/git/revert", map[string]any{"sha": first.SHA}, nil, http.StatusBadRequest, "bad_request")
}

func TestRevertConflictAborts(t *testing.T) {
	f := newFixture(t)
	first := f.commitFile("README.md", "one\n", "one")
	f.commitFile("README.md", "two\n", "two")
	out := f.expectCode(http.MethodPost, "/git/revert", map[string]any{"sha": first.SHA}, author(), http.StatusConflict, "conflict")
	if len(out.Files) != 1 || out.Files[0] != "README.md" {
		t.Fatalf("files %+v", out)
	}
	if st := f.status(); len(st.Changes) != 0 {
		t.Fatalf("revert not aborted %+v", st)
	}
}

func TestValidation(t *testing.T) {
	f := newFixture(t)
	f.expectCode(http.MethodPost, "/git/stage", map[string]any{"paths": []string{".git/config"}}, nil, http.StatusForbidden, "git_dir")
	f.expectCode(http.MethodPost, "/git/stage", map[string]any{"paths": []string{"../escape"}}, nil, http.StatusBadRequest, "bad_request")
	f.expectCode(http.MethodPost, "/git/stage", map[string]any{"paths": []string{}}, nil, http.StatusBadRequest, "bad_request")
	f.expectCode(http.MethodPost, "/git/stage", map[string]any{"paths": "some"}, nil, http.StatusBadRequest, "bad_request")
	f.expectCode(http.MethodGet, "/git/diff?path=.git/HEAD", nil, nil, http.StatusForbidden, "git_dir")
	f.expectCode(http.MethodPost, "/git/commit", map[string]any{"summary": " "}, author(), http.StatusBadRequest, "bad_request")
	f.expectCode(http.MethodPost, "/git/commit", map[string]any{"summary": "x"}, nil, http.StatusBadRequest, "bad_request")
	f.expectCode(http.MethodPost, "/git/commit", map[string]any{"summary": "x", "push": true},
		map[string]string{authorNameHeader: "a", authorEmailHeader: "b"}, http.StatusPreconditionRequired, "github_token_required")
	f.expectCode(http.MethodPost, "/git/checkout", map[string]any{"branch": ""}, nil, http.StatusBadRequest, "bad_request")
	for _, path := range []string{"/git/fetch", "/git/pull", "/git/push"} {
		f.expectCode(http.MethodPost, path, map[string]any{}, nil, http.StatusPreconditionRequired, "github_token_required")
	}
	code, _ := f.do(http.MethodPost, "/git/stage", nil, nil)
	if code != http.StatusBadRequest {
		t.Fatalf("empty body status %d", code)
	}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, f.url+"/git/stage", strings.NewReader("{"))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad json status %d", resp.StatusCode)
	}
	writeFile(t, f.dir, "big.txt", strings.Repeat("0123456789abcdef\n", (maxDiffBytes/17)+1000))
	f.expect(http.MethodPost, "/git/stage", map[string]any{"paths": []string{"big.txt"}}, nil, http.StatusOK, nil)
	f.expectCode(http.MethodGet, "/git/diff?staged=true", nil, nil, http.StatusRequestEntityTooLarge, "too_large")
}

func TestBusy(t *testing.T) {
	f := newFixture(t)
	f.h.mu.Lock()
	defer f.h.mu.Unlock()
	f.expectCode(http.MethodPost, "/git/stage", map[string]any{"paths": "all"}, nil, http.StatusConflict, "busy")
	f.expectCode(http.MethodPost, "/git/clone", map[string]any{"url": f.remote, "wipe": true}, token(), http.StatusConflict, "busy")
	f.status()
}

func TestTokenRedaction(t *testing.T) {
	f := newFixture(t)
	missing := filepath.Join(t.TempDir(), testToken+".git")
	gitCmd(t, f.dir, "remote", "set-url", "origin", missing)
	data := f.expect(http.MethodPost, "/git/fetch", nil, token(), http.StatusUnprocessableEntity, nil)
	if strings.Contains(string(data), testToken) || !strings.Contains(string(data), redacted) {
		t.Fatalf("token not redacted: %s", data)
	}
}

func TestCloneEmptyAndRemoteChecks(t *testing.T) {
	remote := newBareRemote(t)
	f := startFixture(t, remote, checkGitHub)
	f.expectCode(http.MethodPost, "/git/clone", map[string]any{"url": remote}, token(), http.StatusBadRequest, "remote_not_allowed")
	f.expectCode(http.MethodPost, "/git/clone", map[string]any{"url": remote}, nil, http.StatusPreconditionRequired, "github_token_required")
	f.expectCode(http.MethodPost, "/git/clone", map[string]any{"url": remote, "branch": "-x"}, token(), http.StatusBadRequest, "bad_request")
	for _, url := range []string{"http://github.com/a/b", "https://github.com.evil/a/b", "https://github.com/a", "https://github.com/a/b/c", "file:///tmp/x"} {
		if err := checkGitHub(t.Context(), url); !errors.Is(err, errRemote) {
			t.Fatalf("%s accepted: %v", url, err)
		}
	}
	f.h.checkRemote = allowAll
	if err := os.Mkdir(filepath.Join(f.dir, lostFound), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	writeFile(t, f.dir, "stray.txt", "x")
	f.expectCode(http.MethodPost, "/git/clone", map[string]any{"url": remote}, token(), http.StatusConflict, "not_empty")
	f.expect(http.MethodPost, "/git/clone", map[string]any{"url": remote, "branch": "main", "wipe": true}, token(), http.StatusAccepted, nil)
	if state := f.waitClone(); state.State != cloneDone || state.Progress != 100 {
		t.Fatalf("clone %+v", state)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "stray.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("wipe kept file: %v", err)
	}
	if _, err := os.Stat(filepath.Join(f.dir, lostFound)); err != nil {
		t.Fatalf("wipe removed lost+found: %v", err)
	}
	f.expect(http.MethodPost, "/git/clone", map[string]any{"url": filepath.Join(t.TempDir(), "missing.git"), "wipe": true}, token(), http.StatusAccepted, nil)
	if state := f.waitClone(); state.State != cloneFault || state.Error == nil || state.Error.Code != "git_failed" {
		t.Fatalf("failed clone %+v", state)
	}
}

func TestCloneProgress(t *testing.T) {
	h := newHandler(t.TempDir(), "", allowAll)
	for _, tc := range []struct {
		line string
		want int
	}{
		{"Receiving objects:  50% (5/10)", 45},
		{"Resolving deltas: 100% (3/3), done.", 100},
		{"remote: Counting objects", 100},
	} {
		h.cloneProgress(tc.line)
		if h.clone.Progress != tc.want {
			t.Fatalf("%q: progress %d want %d", tc.line, h.clone.Progress, tc.want)
		}
	}
}

func TestAskpassOverHTTP(t *testing.T) {
	remote := newBareRemote(t)
	execPath := strings.TrimSpace(gitCmd(t, t.TempDir(), "--exec-path"))
	backend := filepath.Join(execPath, "git-http-backend")
	if _, err := os.Stat(backend); err != nil {
		t.Skip("git-http-backend not installed")
	}
	cgiHandler := &cgi.Handler{
		Path: backend,
		Env:  []string{"GIT_PROJECT_ROOT=" + filepath.Dir(remote), "GIT_HTTP_EXPORT_ALL=1", "REMOTE_USER=tester"},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		user, pass, ok := req.BasicAuth()
		if !ok || user != tokenUser || pass != testToken {
			w.Header().Set("WWW-Authenticate", `Basic realm="git"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		cgiHandler.ServeHTTP(w, req)
	}))
	t.Cleanup(server.Close)
	f := startFixture(t, remote, allowAll)
	f.cloneOK(server.URL + "/remote.git")
	f.commitFile("http.txt", "h\n", "over http")
	f.expect(http.MethodPost, "/git/push", map[string]any{}, token(), http.StatusOK, nil)
	wrong := map[string]string{tokenHeader: "ghp_wrongtoken"}
	data := f.expect(http.MethodPost, "/git/fetch", nil, wrong, http.StatusUnprocessableEntity, nil)
	if strings.Contains(string(data), "ghp_wrongtoken") {
		t.Fatalf("token leaked: %s", data)
	}
}
