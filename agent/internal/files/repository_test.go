package files

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func newRepositoryServer(t *testing.T) (string, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("eval root: %v", err)
	}
	for _, dir := range []string{".git/objects", ".github/workflows", "sub/.git"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}
	for name, body := range map[string]string{
		".git/config":              "[core]",
		".gitignore":               "target/",
		".github/workflows/ci.yml": "on: push",
		"README.md":                "hello",
		"sub/.git/HEAD":            "ref",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	r := chi.NewRouter()
	MountRepository(r, root)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv.URL, root
}

func repositoryDo(t *testing.T, method, target string, body io.Reader, contentType string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, target, body)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	return resp
}

func TestRepositoryListShowsDotfilesHidesGit(t *testing.T) {
	srvURL, _ := newRepositoryServer(t)
	resp := repositoryDo(t, http.MethodGet, srvURL+"/files/list?path=/", nil, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var entries []Entry
	if err := json.NewDecoder(resp.Body).Decode(&entries); err != nil {
		t.Fatalf("decode: %v", err)
	}
	names := map[string]bool{}
	for _, entry := range entries {
		names[entry.Name] = true
	}
	if !names[".github"] || !names[".gitignore"] || !names["README.md"] || names[".git"] {
		t.Fatalf("unexpected listing %v", names)
	}
	resp = repositoryDo(t, http.MethodGet, srvURL+"/files/list?path=/sub", nil, "")
	defer resp.Body.Close()
	entries = nil
	if err := json.NewDecoder(resp.Body).Decode(&entries); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("nested .git listed: %v", entries)
	}
}

func TestRepositoryDotfilesReadWrite(t *testing.T) {
	srvURL, root := newRepositoryServer(t)
	resp := repositoryDo(t, http.MethodGet, srvURL+"/files/read?path=/.github/workflows/ci.yml", nil, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("read status %d", resp.StatusCode)
	}
	resp = repositoryDo(t, http.MethodPost, srvURL+"/files/write?path=/.gitignore", strings.NewReader("bin/"), "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("write status %d", resp.StatusCode)
	}
	data, err := os.ReadFile(filepath.Join(root, ".gitignore"))
	if err != nil || string(data) != "bin/" {
		t.Fatalf("gitignore %q %v", data, err)
	}
}

func TestRepositoryGitDirRejected(t *testing.T) {
	srvURL, root := newRepositoryServer(t)
	cases := []struct {
		method string
		path   string
		query  url.Values
	}{
		{http.MethodGet, "/files/list", url.Values{"path": {"/.git"}}},
		{http.MethodGet, "/files/read", url.Values{"path": {".git/config"}}},
		{http.MethodGet, "/files/read", url.Values{"path": {"/sub/.git/HEAD"}}},
		{http.MethodGet, "/files/download", url.Values{"path": {"/.git/config"}}},
		{http.MethodGet, "/files/size", url.Values{"path": {"/.git"}}},
		{http.MethodGet, "/files/archive", url.Values{"path": {"/.git"}}},
		{http.MethodPost, "/files/write", url.Values{"path": {"/.git/config"}}},
		{http.MethodPost, "/files/create", url.Values{"path": {"/.git/new"}}},
		{http.MethodPost, "/files/mkdir", url.Values{"path": {"/.git/hooks"}}},
		{http.MethodDelete, "/files/delete", url.Values{"path": {"/.git"}, "recursive": {"true"}}},
		{http.MethodDelete, "/files/delete", url.Values{"path": {"/sub"}, "recursive": {"true"}}},
	}
	for _, tc := range cases {
		resp := repositoryDo(t, tc.method, srvURL+tc.path+"?"+tc.query.Encode(), strings.NewReader("x"), "")
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden || strings.TrimSpace(string(body)) != "git_dir" {
			t.Fatalf("%s %s %v: status %d body %q", tc.method, tc.path, tc.query, resp.StatusCode, body)
		}
	}
	data, err := os.ReadFile(filepath.Join(root, ".git/config"))
	if err != nil || string(data) != "[core]" {
		t.Fatalf("git config changed %q %v", data, err)
	}
}

func TestRepositoryUpload(t *testing.T) {
	srvURL, root := newRepositoryServer(t)
	upload := func(name string) int {
		var buf bytes.Buffer
		writer := multipart.NewWriter(&buf)
		part, err := writer.CreateFormFile("file", name)
		if err != nil {
			t.Fatalf("form: %v", err)
		}
		_, _ = part.Write([]byte("data"))
		_ = writer.Close()
		resp := repositoryDo(t, http.MethodPost, srvURL+"/files/upload?path=/", &buf, writer.FormDataContentType())
		defer resp.Body.Close()
		return resp.StatusCode
	}
	if status := upload(".editorconfig"); status != http.StatusNoContent {
		t.Fatalf("dotfile upload status %d", status)
	}
	if _, err := os.Stat(filepath.Join(root, ".editorconfig")); err != nil {
		t.Fatalf("uploaded: %v", err)
	}
	if status := upload(".git"); status != http.StatusForbidden {
		t.Fatalf(".git upload status %d", status)
	}
}

func TestRepositorySizeSkipsGit(t *testing.T) {
	srvURL, _ := newRepositoryServer(t)
	resp := repositoryDo(t, http.MethodGet, srvURL+"/files/size?path=/", nil, "")
	defer resp.Body.Close()
	var out map[string]int64
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := int64(len("target/") + len("on: push") + len("hello"))
	if out["size"] != want {
		t.Fatalf("size %d want %d", out["size"], want)
	}
}

func TestGameServerDotfilesStillRejected(t *testing.T) {
	srvURL, root := newServer(t)
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	resp := repositoryDo(t, http.MethodGet, srvURL+"/files/read?path=/.gitignore", nil, "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d", resp.StatusCode)
	}
}
