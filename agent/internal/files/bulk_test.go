package files

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
}

func bulkTree(t *testing.T) (string, string) {
	t.Helper()
	srvURL, root := newServer(t)
	writeTree(t, root, map[string]string{
		"plugins/a.jar":      "jar",
		"plugins/conf/b.yml": "yaml!",
		"plugins/.hidden/c":  "hidden",
		"plugins/.secret":    "secret",
		"notes.txt":          "hi",
	})
	if err := os.Symlink(filepath.Join(root, "notes.txt"), filepath.Join(root, "plugins", "link")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	return srvURL, root
}

func readZip(t *testing.T, data []byte) map[string]string {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("open zip: %v", err)
	}
	entries := map[string]string{}
	for _, file := range reader.File {
		if strings.HasSuffix(file.Name, "/") {
			entries[file.Name] = ""
			continue
		}
		body, err := file.Open()
		if err != nil {
			t.Fatalf("open %s: %v", file.Name, err)
		}
		content, err := io.ReadAll(body)
		_ = body.Close()
		if err != nil {
			t.Fatalf("read %s: %v", file.Name, err)
		}
		entries[file.Name] = string(content)
	}
	return entries
}

func TestSize(t *testing.T) {
	srvURL, _ := bulkTree(t)
	for path, want := range map[string]int64{"/plugins": 8, "/": 10} {
		resp := get(t, srvURL, "/files/size", url.Values{"path": []string{path}})
		var body struct {
			Size int64 `json:"size"`
		}
		err := json.NewDecoder(resp.Body).Decode(&body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK || err != nil {
			t.Fatalf("%s: status=%d err=%v", path, resp.StatusCode, err)
		}
		if body.Size != want {
			t.Fatalf("%s: size=%d, want %d", path, body.Size, want)
		}
	}
}

func TestSize_Errors(t *testing.T) {
	srvURL, _ := bulkTree(t)
	for path, want := range map[string]int{"/missing": http.StatusNotFound, "/plugins/.hidden": http.StatusBadRequest, "/notes.txt": http.StatusBadRequest} {
		resp := get(t, srvURL, "/files/size", url.Values{"path": []string{path}})
		_ = resp.Body.Close()
		if resp.StatusCode != want {
			t.Fatalf("%s: status=%d, want %d", path, resp.StatusCode, want)
		}
	}
}

func TestSize_SkipsVanishedDirectory(t *testing.T) {
	_, root := bulkTree(t)
	h := &handler{root: root, beforeOpen: func(_, _, name string) {
		if name == "conf" {
			_ = os.RemoveAll(filepath.Join(root, "plugins", "conf"))
		}
	}}
	total, err := h.treeSize(t.Context(), []string{"plugins"})
	if err != nil || total != 3 {
		t.Fatalf("size=%d err=%v, want 3", total, err)
	}
}

func TestCanceledWalks(t *testing.T) {
	_, root := bulkTree(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	h := &handler{root: root, beforeOpen: func(_, _, name string) {
		if name == "conf" {
			cancel()
		}
	}}
	if _, err := h.treeSize(ctx, []string{"plugins"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("treeSize err=%v", err)
	}
	if err := h.writeArchive(ctx, io.Discard, [][]string{{"plugins"}}); !errors.Is(err, context.Canceled) {
		t.Fatalf("writeArchive err=%v", err)
	}
}

func TestArchive(t *testing.T) {
	srvURL, _ := bulkTree(t)
	for _, tc := range []struct {
		paths    []string
		filename string
		want     map[string]string
	}{
		{[]string{"/plugins"}, "plugins.zip", map[string]string{"plugins/": "", "plugins/a.jar": "jar", "plugins/conf/": "", "plugins/conf/b.yml": "yaml!"}},
		{[]string{"/plugins/conf", "/notes.txt"}, "archive.zip", map[string]string{"conf/": "", "conf/b.yml": "yaml!", "notes.txt": "hi"}},
	} {
		resp := get(t, srvURL, "/files/archive", url.Values{"path": tc.paths})
		data, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK || err != nil {
			t.Fatalf("%v: status=%d err=%v", tc.paths, resp.StatusCode, err)
		}
		if got := resp.Header.Get("Content-Disposition"); got != `attachment; filename="`+tc.filename+`"` {
			t.Fatalf("%v: disposition=%q", tc.paths, got)
		}
		if got := readZip(t, data); !maps.Equal(got, tc.want) {
			t.Fatalf("%v: entries=%v, want %v", tc.paths, got, tc.want)
		}
	}
}

func TestArchive_Rejects(t *testing.T) {
	srvURL, _ := bulkTree(t)
	for _, paths := range [][]string{nil, {"/"}, {"/plugins/.secret"}, slices.Repeat([]string{"/notes.txt"}, maxArchivePaths+1)} {
		resp := get(t, srvURL, "/files/archive", url.Values{"path": paths})
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%d paths: status=%d", len(paths), resp.StatusCode)
		}
	}
}

func TestArchive_MissingPathEndsStream(t *testing.T) {
	srvURL, root := bulkTree(t)
	resp := get(t, srvURL, "/files/archive", url.Values{"path": []string{"/missing"}})
	data, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || err != nil || len(data) != 0 {
		t.Fatalf("status=%d err=%v bytes=%d", resp.StatusCode, err, len(data))
	}
	h := &handler{root: root}
	if err := h.writeArchive(t.Context(), io.Discard, [][]string{{"missing"}}); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("writeArchive err=%v", err)
	}
}

func TestCreateZip(t *testing.T) {
	srvURL, root := bulkTree(t)
	query := url.Values{"path": []string{"/plugins"}, "dest": []string{"/plugins/backup.zip"}}
	resp, err := testPost(t, srvURL+"/files/zip?"+query.Encode(), "application/octet-stream", nil)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	data, err := os.ReadFile(filepath.Join(root, "plugins", "backup.zip"))
	if err != nil {
		t.Fatalf("read zip: %v", err)
	}
	want := map[string]string{"plugins/": "", "plugins/a.jar": "jar", "plugins/conf/": "", "plugins/conf/b.yml": "yaml!"}
	if got := readZip(t, data); !maps.Equal(got, want) {
		t.Fatalf("entries=%v, want %v", got, want)
	}
}

func TestCreateZip_Rejects(t *testing.T) {
	srvURL, root := bulkTree(t)
	for _, tc := range []struct {
		query url.Values
		want  int
	}{
		{url.Values{"dest": []string{"/out.zip"}}, http.StatusBadRequest},
		{url.Values{"path": []string{"/plugins"}, "dest": []string{"/.out.zip"}}, http.StatusBadRequest},
		{url.Values{"path": []string{"/missing"}, "dest": []string{"/out.zip"}}, http.StatusNotFound},
	} {
		resp, err := testPost(t, srvURL+"/files/zip?"+tc.query.Encode(), "application/octet-stream", nil)
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != tc.want {
			t.Fatalf("%v: status=%d, want %d", tc.query, resp.StatusCode, tc.want)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "out.zip")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("partial archive left behind: %v", err)
	}
}

func TestArchive_SkipsVanishedEntry(t *testing.T) {
	_, root := bulkTree(t)
	h := &handler{root: root, beforeOpen: func(_, _, name string) {
		if name == "conf" {
			_ = os.RemoveAll(filepath.Join(root, "plugins", "conf"))
		}
	}}
	var buffer bytes.Buffer
	if err := h.writeArchive(t.Context(), &buffer, [][]string{{"plugins"}}); err != nil {
		t.Fatalf("writeArchive: %v", err)
	}
	want := map[string]string{"plugins/": "", "plugins/a.jar": "jar"}
	if got := readZip(t, buffer.Bytes()); !maps.Equal(got, want) {
		t.Fatalf("entries=%v, want %v", got, want)
	}
}
