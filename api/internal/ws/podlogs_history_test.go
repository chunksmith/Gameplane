package ws

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/GameplanePanel/gameplane/api/internal/kube"
)

func getPodLogHistory(t *testing.T, k *kube.Client, query string) (int, []string) {
	t.Helper()
	r := chi.NewRouter()
	mountPodLogs(r, streamTestRegistry(k))
	srv := httptest.NewServer(r)
	defer srv.Close()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, srv.URL+"/servers/alpha/logs/pod/history"+query, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	var lines []string
	if resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(&lines); err != nil {
			t.Fatalf("decode: %v", err)
		}
	}
	return resp.StatusCode, lines
}

func TestPodLogHistory_StitchesTimeline(t *testing.T) {
	k := &kube.Client{Typed: fake.NewSimpleClientset(newPod("alpha-0", []string{"config-init"}, false))}
	status, lines := getPodLogHistory(t, k, "?skip=0&limit=10")
	want := []string{"── config-init ──", "fake logs", "── game ──", "fake logs"}
	if status != http.StatusOK || !slices.Equal(lines, want) {
		t.Fatalf("status=%d lines=%q, want %q", status, lines, want)
	}
}

func TestPodLogHistory_RejectsInvalidPaging(t *testing.T) {
	k := &kube.Client{Typed: fake.NewSimpleClientset(newPod("alpha-0", nil, false))}
	for _, query := range []string{"", "?skip=-1&limit=10", "?skip=0&limit=0", "?skip=0&limit=5001", "?skip=x&limit=10"} {
		if status, _ := getPodLogHistory(t, k, query); status != http.StatusBadRequest {
			t.Errorf("%q: status=%d, want 400", query, status)
		}
	}
}

func TestPodLogHistory_NoPod(t *testing.T) {
	k := &kube.Client{Typed: fake.NewSimpleClientset()}
	if status, _ := getPodLogHistory(t, k, "?skip=0&limit=10"); status != http.StatusNotFound {
		t.Fatalf("status=%d, want 404", status)
	}
}

func TestPodLogs_TailStreamsOnlyRunningGame(t *testing.T) {
	k := &kube.Client{Typed: fake.NewSimpleClientset(newPod("alpha-0", []string{"config-init"}, false))}
	out, err := dialPodLogs(t, k, "?from=start&tail=1000")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if !strings.Contains(out, "fake logs") || strings.Contains(out, "──") {
		t.Errorf("out = %q, want only the game tail", out)
	}
}

func TestLogPage_PagesBackwardsAcrossSteps(t *testing.T) {
	logs := map[string][]string{"init": {"i1", "i2"}, "game": {"g1", "g2", "g3", "g4", "g5"}}
	read := func(_ context.Context, container string, tail, keep int64) ([]string, int64, error) {
		lines := logs[container]
		lines = lines[max(int64(len(lines))-tail, 0):]
		return lines[:min(int64(len(lines)), keep)], int64(len(lines)), nil
	}
	cases := []struct {
		skip, limit int64
		want        []string
	}{
		{0, 2, []string{"g4", "g5"}},
		{2, 2, []string{"g2", "g3"}},
		{4, 3, []string{"i2", "── game ──", "g1"}},
		{7, 5, []string{"── init ──", "i1"}},
		{9, 5, []string{}},
	}
	for _, c := range cases {
		got, err := logPage(t.Context(), []string{"init", "game"}, true, c.skip, c.limit, read)
		if err != nil || !slices.Equal(got, c.want) {
			t.Errorf("skip=%d limit=%d: got %q err %v, want %q", c.skip, c.limit, got, err, c.want)
		}
	}
}

func TestLogPage_ReturnsReadError(t *testing.T) {
	read := func(context.Context, string, int64, int64) ([]string, int64, error) {
		return nil, 0, errors.New("boom")
	}
	if _, err := logPage(t.Context(), []string{"game"}, false, 0, 1, read); err == nil {
		t.Fatal("want error")
	}
}
