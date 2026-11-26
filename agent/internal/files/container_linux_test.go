package files

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func fakeProc(t *testing.T, roots map[string]string) (string, string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"data", "agent", "other"} {
		if err := os.Mkdir(filepath.Join(base, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	proc := filepath.Join(base, "proc")
	roots["self"] = "agent"
	for pid, target := range roots {
		if !filepath.IsAbs(target) {
			target = filepath.Join(base, target)
		}
		if err := os.MkdirAll(filepath.Join(proc, pid), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, filepath.Join(proc, pid, "root")); err != nil {
			t.Fatal(err)
		}
	}
	return proc, filepath.Join(base, "data")
}

func TestGameDirPicksLowestGameProcess(t *testing.T) {
	proc, data := fakeProc(t, map[string]string{"7": "agent", "9": "other", "40": "/", "12": "/"})
	if err := os.Mkdir(filepath.Join(proc, "status"), 0o755); err != nil {
		t.Fatal(err)
	}
	dir, err := gameDir(proc, data)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(proc, "12", "cwd"); dir != want {
		t.Fatalf("got %q, want %q", dir, want)
	}
}

func TestGameDirWithoutGameProcess(t *testing.T) {
	proc, data := fakeProc(t, map[string]string{"7": "agent", "9": "other"})
	if _, err := gameDir(proc, data); !errors.Is(err, errNoGameProcess) {
		t.Fatalf("got %v, want errNoGameProcess", err)
	}
}

func TestContainerRootServesGameDir(t *testing.T) {
	game := t.TempDir()
	if err := os.WriteFile(filepath.Join(game, "velocity.toml"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	mount(r, &handler{root: t.TempDir(), containerRoot: func() (string, error) { return game, nil }})
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/files/list?path=/", nil))
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "velocity.toml") {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
}
