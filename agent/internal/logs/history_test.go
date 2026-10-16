package logs

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/iotest"
)

func TestHistory_PagesBackwardsFromEnd(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "latest.log")
	if err := os.WriteFile(logPath, []byte("one\ntwo\r\nthree\nfour\nfive"), 0o600); err != nil {
		t.Fatalf("create: %v", err)
	}
	url := mountServer(t, dir, logPath)
	cases := map[string][]string{
		"?skip=0&limit=2":  {"four", "five"},
		"?skip=2&limit=2":  {"two", "three"},
		"?skip=4&limit=10": {"one"},
		"?skip=5&limit=10": {},
	}
	for query, want := range cases {
		resp, err := testGet(t, url+"/logs/history"+query)
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		var got []string
		err = json.NewDecoder(resp.Body).Decode(&got)
		resp.Body.Close()
		if err != nil || resp.StatusCode != http.StatusOK || !slices.Equal(got, want) {
			t.Errorf("%s: status=%d got=%q err=%v, want %q", query, resp.StatusCode, got, err, want)
		}
	}
}

func TestHistory_RejectsBadRequests(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "latest.log")
	cases := []struct {
		url    string
		status int
	}{
		{mountServer(t, dir, "") + "/logs/history?skip=0&limit=1", http.StatusServiceUnavailable},
		{mountServer(t, dir, logPath) + "/logs/history?skip=-1&limit=1", http.StatusBadRequest},
		{mountServer(t, dir, logPath) + "/logs/history?skip=0&limit=0", http.StatusBadRequest},
		{mountServer(t, dir, logPath) + "/logs/history?skip=0&limit=20001", http.StatusBadRequest},
		{mountServer(t, dir, logPath) + "/logs/history?skip=0&limit=1", http.StatusNotFound},
	}
	for _, c := range cases {
		resp, err := testGet(t, c.url)
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		resp.Body.Close()
		if resp.StatusCode != c.status {
			t.Errorf("%s: status=%d, want %d", c.url, resp.StatusCode, c.status)
		}
	}
}

type seekFailingLog struct {
	io.Reader
}

func (seekFailingLog) Seek(int64, int) (int64, error) { return 0, errors.New("seek failed") }

func TestHistoryPage_ReportsReadErrors(t *testing.T) {
	if _, err := historyPage(seekFailingLog{iotest.ErrReader(errors.New("read failed"))}, 0, 1); err == nil {
		t.Error("count error: want error")
	}
	if _, err := historyPage(seekFailingLog{strings.NewReader("one\n")}, 0, 1); err == nil {
		t.Error("seek error: want error")
	}
}
