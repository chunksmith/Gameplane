package files

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

const outsideSecret = "outside-secret"

// put writes content to path, creating parent directories.
func put(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// raceHandler returns a handler on a fresh root and a separate "outside"
// directory holding secret.txt, which must never be read, written or deleted.
func raceHandler(t *testing.T) (*handler, string, string) {
	t.Helper()
	root := resolvedTempDir(t)
	outside := resolvedTempDir(t)
	put(t, filepath.Join(outside, "secret.txt"), outsideSecret)
	return &handler{root: root}, root, outside
}

// serve calls a handler method directly (same goroutine, no server).
func serve(t *testing.T, fn http.HandlerFunc, method, target string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	rr := httptest.NewRecorder()
	fn(rr, httptest.NewRequestWithContext(t.Context(), method, target, body))
	return rr
}

// swapForSymlink moves path aside (path+".moved") and puts a symlink to
// target in its place, simulating another process racing the request.
func swapForSymlink(t *testing.T, path, target string) {
	t.Helper()
	if err := os.Rename(path, path+".moved"); err != nil {
		t.Fatalf("move aside %s: %v", path, err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatalf("symlink %s: %v", path, err)
	}
}

// raceAt installs a hook that runs swap on the nth call matching
// (stage, dir, name) and fails the test if that call is never reached.
func raceAt(t *testing.T, h *handler, stage, dir, name string, nth int, swap func()) {
	t.Helper()
	seen := 0
	h.beforeOpen = func(s, d, n string) {
		if s != stage || d != dir || n != name {
			return
		}
		seen++
		if seen == nth {
			swap()
		}
	}
	t.Cleanup(func() {
		if seen < nth {
			t.Errorf("race hook %s %q/%q never reached call %d (saw %d)", stage, dir, name, nth, seen)
		}
	})
}

func assertRejected(t *testing.T, rr *httptest.ResponseRecorder) {
	t.Helper()
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%q, want 400", rr.Code, rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), outsideSecret) {
		t.Fatalf("response leaked outside content: %q", rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "escapes root") {
		t.Fatalf("body=%q, want it to mention 'escapes root'", rr.Body.String())
	}
}

func assertOutsideUntouched(t *testing.T, outside string) {
	t.Helper()
	entries, err := os.ReadDir(outside)
	if err != nil {
		t.Fatalf("readdir outside: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "secret.txt" {
		t.Fatalf("outside directory modified: %v", entries)
	}
	got, err := os.ReadFile(filepath.Join(outside, "secret.txt"))
	if err != nil || string(got) != outsideSecret {
		t.Fatalf("outside secret modified: got %q err=%v", got, err)
	}
}

func TestRace_ReadDirectorySwappedForSymlink(t *testing.T) {
	h, root, outside := raceHandler(t)
	put(t, filepath.Join(root, "sub", "secret.txt"), "inside")
	raceAt(t, h, "open", "", "sub", 1, func() { swapForSymlink(t, filepath.Join(root, "sub"), outside) })
	rr := serve(t, h.read, http.MethodGet, "/files/read?path=/sub/secret.txt", nil)
	assertRejected(t, rr)
	assertOutsideUntouched(t, outside)
}

func TestRace_ReadFileSwappedForSymlink(t *testing.T) {
	h, root, outside := raceHandler(t)
	put(t, filepath.Join(root, "data.txt"), "inside")
	raceAt(t, h, "open", "", "data.txt", 1, func() {
		swapForSymlink(t, filepath.Join(root, "data.txt"), filepath.Join(outside, "secret.txt"))
	})
	rr := serve(t, h.read, http.MethodGet, "/files/read?path=/data.txt", nil)
	assertRejected(t, rr)
	assertOutsideUntouched(t, outside)
}

func TestRace_DownloadFileSwappedForSymlink(t *testing.T) {
	h, root, outside := raceHandler(t)
	put(t, filepath.Join(root, "data.txt"), "inside")
	raceAt(t, h, "open", "", "data.txt", 1, func() {
		swapForSymlink(t, filepath.Join(root, "data.txt"), filepath.Join(outside, "secret.txt"))
	})
	rr := serve(t, h.download, http.MethodGet, "/files/download?path=/data.txt", nil)
	assertRejected(t, rr)
	assertOutsideUntouched(t, outside)
}

func TestRace_ListDirectorySwappedForSymlink(t *testing.T) {
	h, root, outside := raceHandler(t)
	put(t, filepath.Join(root, "sub", "a.txt"), "inside")
	raceAt(t, h, "open", "", "sub", 1, func() { swapForSymlink(t, filepath.Join(root, "sub"), outside) })
	rr := serve(t, h.list, http.MethodGet, "/files/list?path=/sub", nil)
	assertRejected(t, rr)
	if strings.Contains(rr.Body.String(), "secret.txt") {
		t.Fatalf("listing leaked outside names: %q", rr.Body.String())
	}
	assertOutsideUntouched(t, outside)
}

func TestRace_WriteDirectorySwappedForSymlink(t *testing.T) {
	h, root, outside := raceHandler(t)
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	raceAt(t, h, "open", "", "sub", 1, func() { swapForSymlink(t, filepath.Join(root, "sub"), outside) })
	rr := serve(t, h.write, http.MethodPost, "/files/write?path=/sub/new.txt", strings.NewReader("payload"))
	assertRejected(t, rr)
	assertOutsideUntouched(t, outside)
}

// The destination name is swapped for a symlink to an outside file right
// before the final rename: renameat replaces the link itself, the outside
// file is not written through it.
func TestRace_WriteDestinationSwappedForSymlink(t *testing.T) {
	h, root, outside := raceHandler(t)
	put(t, filepath.Join(root, "target.txt"), "old")
	raceAt(t, h, "commit", "", "target.txt", 1, func() {
		swapForSymlink(t, filepath.Join(root, "target.txt"), filepath.Join(outside, "secret.txt"))
	})
	rr := serve(t, h.write, http.MethodPost, "/files/write?path=/target.txt", strings.NewReader("new"))
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%q, want 204", rr.Code, rr.Body.String())
	}
	assertOutsideUntouched(t, outside)
	fi, err := os.Lstat(filepath.Join(root, "target.txt"))
	if err != nil || !fi.Mode().IsRegular() {
		t.Fatalf("target.txt not a regular file after write: fi=%v err=%v", fi, err)
	}
	got, err := os.ReadFile(filepath.Join(root, "target.txt"))
	if err != nil || string(got) != "new" {
		t.Fatalf("target.txt content=%q err=%v", got, err)
	}
}

// The directory is swapped for a symlink after its descriptor was opened:
// the write lands in the original (moved) directory, never outside the root.
func TestRace_HeldDirectoryDescriptorStaysInRoot(t *testing.T) {
	h, root, outside := raceHandler(t)
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	raceAt(t, h, "commit", "sub", "f.txt", 1, func() { swapForSymlink(t, filepath.Join(root, "sub"), outside) })
	rr := serve(t, h.write, http.MethodPost, "/files/write?path=/sub/f.txt", strings.NewReader("payload"))
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%q, want 204", rr.Code, rr.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(root, "sub.moved", "f.txt"))
	if err != nil || string(got) != "payload" {
		t.Fatalf("write did not land in the original directory: got %q err=%v", got, err)
	}
	assertOutsideUntouched(t, outside)
}

func TestRace_MkdirAncestorSwappedForSymlink(t *testing.T) {
	h, root, outside := raceHandler(t)
	if err := os.Mkdir(filepath.Join(root, "a"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	raceAt(t, h, "open", "", "a", 1, func() { swapForSymlink(t, filepath.Join(root, "a"), outside) })
	rr := serve(t, h.mkdir, http.MethodPost, "/files/mkdir?path=/a/b/c", nil)
	assertRejected(t, rr)
	assertOutsideUntouched(t, outside)
}

// The upload directory is swapped between the directory creation step (open #1)
// and the part being stored (open #2).
func TestRace_UploadDirectorySwappedForSymlink(t *testing.T) {
	h, root, outside := raceHandler(t)
	if err := os.Mkdir(filepath.Join(root, "up"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	raceAt(t, h, "open", "", "up", 2, func() { swapForSymlink(t, filepath.Join(root, "up"), outside) })
	buf, ct := multipartBody(t, map[string]string{"x.txt": "payload"})
	req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/files/upload?path=/up", buf)
	req.Header.Set("Content-Type", ct)
	rr := httptest.NewRecorder()
	h.upload(rr, req)
	assertRejected(t, rr)
	assertOutsideUntouched(t, outside)
}

func TestRace_DeleteAncestorSwappedForSymlink(t *testing.T) {
	h, root, outside := raceHandler(t)
	put(t, filepath.Join(root, "a", "b", "file"), "inside")
	put(t, filepath.Join(outside, "b", "file"), "outside-keep")
	raceAt(t, h, "open", "", "a", 1, func() { swapForSymlink(t, filepath.Join(root, "a"), outside) })
	rr := serve(t, h.del, http.MethodDelete, "/files/delete?path=/a/b&recursive=true", nil)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%q, want 400", rr.Code, rr.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(outside, "b", "file"))
	if err != nil || string(got) != "outside-keep" {
		t.Fatalf("outside file deleted or modified: got %q err=%v", got, err)
	}
}

// A child directory of the tree being deleted is swapped for a symlink after
// the removal pass saw it as a directory (open #1 of tree/inner).
func TestRace_RecursiveDeleteChildSwappedForSymlink(t *testing.T) {
	h, root, outside := raceHandler(t)
	put(t, filepath.Join(root, "tree", "inner", "file"), "inside")
	raceAt(t, h, "open", "tree", "inner", 1, func() { swapForSymlink(t, filepath.Join(root, "tree", "inner"), outside) })
	rr := serve(t, h.del, http.MethodDelete, "/files/delete?path=/tree&recursive=true", nil)
	assertRejected(t, rr)
	assertOutsideUntouched(t, outside)
}

func TestRooted_InRootSymlinkRejectedAtEveryComponent(t *testing.T) {
	h, root, _ := raceHandler(t)
	put(t, filepath.Join(root, "real", "f.txt"), "inside")
	if err := os.Symlink(filepath.Join(root, "real"), filepath.Join(root, "lnk")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	cases := []struct {
		name   string
		fn     http.HandlerFunc
		method string
		target string
	}{
		{"read", h.read, http.MethodGet, "/files/read?path=/lnk/f.txt"},
		{"download", h.download, http.MethodGet, "/files/download?path=/lnk/f.txt"},
		{"list", h.list, http.MethodGet, "/files/list?path=/lnk"},
		{"write", h.write, http.MethodPost, "/files/write?path=/lnk/n.txt"},
		{"mkdir", h.mkdir, http.MethodPost, "/files/mkdir?path=/lnk/sub"},
		{"delete", h.del, http.MethodDelete, "/files/delete?path=/lnk/f.txt"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rr := serve(t, tc.fn, tc.method, tc.target, strings.NewReader("x"))
			if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "escapes root") {
				t.Fatalf("status=%d body=%q, want 400 escapes root", rr.Code, rr.Body.String())
			}
		})
	}
	entries, err := os.ReadDir(filepath.Join(root, "real"))
	if err != nil || len(entries) != 1 || entries[0].Name() != "f.txt" {
		t.Fatalf("real directory modified: %v err=%v", entries, err)
	}
}

func TestRooted_WriteRejectsSymlinkDestination(t *testing.T) {
	h, root, _ := raceHandler(t)
	put(t, filepath.Join(root, "real.txt"), "orig")
	if err := os.Symlink(filepath.Join(root, "real.txt"), filepath.Join(root, "link")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	rr := serve(t, h.write, http.MethodPost, "/files/write?path=/link", strings.NewReader("new"))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%q, want 400", rr.Code, rr.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(root, "real.txt"))
	if err != nil || string(got) != "orig" {
		t.Fatalf("target modified: got %q err=%v", got, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 2 {
		t.Fatalf("unexpected root contents (stray temp file?): %v err=%v", entries, err)
	}
}

func TestRooted_RecursiveDeleteDoesNotFollowSymlinks(t *testing.T) {
	h, root, outside := raceHandler(t)
	put(t, filepath.Join(root, "tree", "a.txt"), "inside")
	if err := os.Symlink(outside, filepath.Join(root, "tree", "out")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	rr := serve(t, h.del, http.MethodDelete, "/files/delete?path=/tree&recursive=true", nil)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%q, want 204", rr.Code, rr.Body.String())
	}
	if _, err := os.Lstat(filepath.Join(root, "tree")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("tree still present: %v", err)
	}
	assertOutsideUntouched(t, outside)
}

func TestRooted_SymlinkedRootStillServes(t *testing.T) {
	linkRoot, realRoot := symlinkedRoot(t)
	put(t, filepath.Join(realRoot, "f.txt"), "hello")
	h := &handler{root: linkRoot}
	rr := serve(t, h.read, http.MethodGet, "/files/read?path=/f.txt", nil)
	if rr.Code != http.StatusOK || rr.Body.String() != "hello" {
		t.Fatalf("status=%d body=%q, want 200 hello", rr.Code, rr.Body.String())
	}
	rr = serve(t, h.write, http.MethodPost, "/files/write?path=/g/n.txt", strings.NewReader("new"))
	if rr.Code != http.StatusNoContent {
		t.Fatalf("write status=%d body=%q, want 204", rr.Code, rr.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(realRoot, "g", "n.txt"))
	if err != nil || string(got) != "new" {
		t.Fatalf("write not stored: got %q err=%v", got, err)
	}
}

func TestRooted_RelativeSymlinkToDotTargetIsDotfile(t *testing.T) {
	h, root, _ := raceHandler(t)
	if err := os.Symlink(".hidden/x", filepath.Join(root, "rel")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	rr := serve(t, h.read, http.MethodGet, "/files/read?path=/rel", nil)
	if rr.Code != http.StatusBadRequest || rr.Body.String() != "dotfile access denied\n" {
		t.Fatalf("status=%d body=%q, want 400 dotfile access denied", rr.Code, rr.Body.String())
	}
}

func TestRooted_DeleteMissingEntries(t *testing.T) {
	h, root, _ := raceHandler(t)
	put(t, filepath.Join(root, "keep"), "x")
	// A missing parent stays a generic 400, a missing final entry a 404, and a
	// recursive delete of a missing entry succeeds (os.RemoveAll semantics).
	cases := []struct {
		target string
		want   int
	}{
		{"/files/delete?path=/missing/x", http.StatusBadRequest},
		{"/files/delete?path=/nope", http.StatusNotFound},
		{"/files/delete?path=/nope&recursive=true", http.StatusNoContent},
	}
	for _, tc := range cases {
		rr := serve(t, h.del, http.MethodDelete, tc.target, nil)
		if rr.Code != tc.want {
			t.Fatalf("%s: status=%d body=%q, want %d", tc.target, rr.Code, rr.Body.String(), tc.want)
		}
	}
}

func TestRooted_WriteToRootFails(t *testing.T) {
	h, _, _ := raceHandler(t)
	rr := serve(t, h.write, http.MethodPost, "/files/write?path=/", strings.NewReader("x"))
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%q, want 500", rr.Code, rr.Body.String())
	}
}

func TestRooted_ListReportsLinksAndPaths(t *testing.T) {
	h, root, outside := raceHandler(t)
	put(t, filepath.Join(root, "d", "f.txt"), "12345")
	if err := os.Symlink(outside, filepath.Join(root, "d", "lnk")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	rr := serve(t, h.list, http.MethodGet, "/files/list?path=/d", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%q", rr.Code, rr.Body.String())
	}
	var ents []Entry
	if err := json.Unmarshal(rr.Body.Bytes(), &ents); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(ents) != 2 {
		t.Fatalf("got %d entries: %+v", len(ents), ents)
	}
	// Sorted by name: f.txt then lnk.
	if ents[0].Name != "f.txt" || ents[0].Path != "/d/f.txt" || ents[0].Size != 5 || ents[0].Dir || ents[0].ModTime == "" {
		t.Fatalf("file entry=%+v", ents[0])
	}
	if ents[1].Name != "lnk" || ents[1].Path != "/d/lnk" || ents[1].Dir || !strings.HasPrefix(ents[1].Mode, "L") {
		t.Fatalf("link entry=%+v, want a non-dir entry with mode starting L", ents[1])
	}
}

func TestRelComponents(t *testing.T) {
	cases := []struct {
		name    string
		root    string
		abs     string
		want    []string
		wantErr error
	}{
		{"root", "/data", "/data", nil, nil},
		{"nested", "/data", "/data/a/b", []string{"a", "b"}, nil},
		{"outside", "/data", "/etc", nil, errPathOutOfRoot},
		{"sibling prefix", "/data", "/data2/x", nil, errPathOutOfRoot},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := relComponents(tc.root, tc.abs)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err=%v, want %v", err, tc.wantErr)
			}
			if !slices.Equal(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestFileModeFromStat(t *testing.T) {
	cases := []struct {
		name string
		in   uint32
		want os.FileMode
	}{
		{"regular", unix.S_IFREG | 0o644, 0o644},
		{"dir", unix.S_IFDIR | 0o755, os.ModeDir | 0o755},
		{"symlink", unix.S_IFLNK | 0o777, os.ModeSymlink | 0o777},
		{"fifo", unix.S_IFIFO | 0o600, os.ModeNamedPipe | 0o600},
		{"socket", unix.S_IFSOCK | 0o600, os.ModeSocket | 0o600},
		{"char device", unix.S_IFCHR | 0o600, os.ModeDevice | os.ModeCharDevice | 0o600},
		{"block device", unix.S_IFBLK | 0o600, os.ModeDevice | 0o600},
		{"special bits", unix.S_IFREG | unix.S_ISUID | unix.S_ISGID | unix.S_ISVTX | 0o755, os.ModeSetuid | os.ModeSetgid | os.ModeSticky | 0o755},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := fileModeFromStat(tc.in); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestRemoveEntry(t *testing.T) {
	dir := resolvedTempDir(t)
	put(t, filepath.Join(dir, "f"), "x")
	put(t, filepath.Join(dir, "full", "x"), "x")
	if err := os.Mkdir(filepath.Join(dir, "empty"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	fd, err := openat(unix.AT_FDCWD, dir, dirFlags, 0)
	if err != nil {
		t.Fatalf("open dir: %v", err)
	}
	defer closeFD(fd)
	if err := removeEntry(fd, "f"); err != nil {
		t.Fatalf("remove file: %v", err)
	}
	if err := removeEntry(fd, "empty"); err != nil {
		t.Fatalf("remove empty dir: %v", err)
	}
	if err := removeEntry(fd, "full"); !errors.Is(err, unix.ENOTEMPTY) {
		t.Fatalf("remove non-empty dir: got %v, want ENOTEMPTY", err)
	}
	if err := removeEntry(fd, "missing"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("remove missing: got %v, want ErrNotExist", err)
	}
}

func TestFileFromFDRejectsNegative(t *testing.T) {
	if f, err := fileFromFD(-1, "x"); f != nil || !errors.Is(err, unix.EBADF) {
		t.Fatalf("got f=%v err=%v, want nil and EBADF", f, err)
	}
}
