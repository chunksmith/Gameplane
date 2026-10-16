package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestIsStreamingRequest(t *testing.T) {
	cases := []struct {
		name   string
		method string
		path   string
		header string
		want   bool
	}{
		{"websocket upgrade", "GET", "/ws/servers/alpha/console", "websocket", true},
		{"websocket upgrade case-insensitive", "GET", "/ws/servers/alpha/console", "WebSocket", true},
		{"events GET", "GET", "/events", "", true},
		{"events GET with query", "GET", "/events?namespace=gameplane-games", "", true},
		{"events wrong method", "POST", "/events", "", false},
		{"assistant stream GET", "GET", "/ai/conversations/abc/stream", "", true},
		{"assistant stream wrong method", "POST", "/ai/conversations/abc/stream", "", false},
		{"assistant detail GET", "GET", "/ai/conversations/abc", "", false},
		{"unrelated path", "GET", "/servers/alpha", "", false},
		{"unrelated upgrade value", "GET", "/servers/alpha", "h2c", false},
		// F-074: large-transfer routes (isLargeTransferPath).
		{"files download GET", "GET", "/servers/a/files/download", "", true},
		{"files archive GET", "GET", "/servers/a/files/archive", "", true},
		{"logs download GET", "GET", "/servers/a/logs/download", "", true},
		{"capture file GET", "GET", "/servers/a:capture-file", "", true},
		{"audit export GET", "GET", "/admin/audit/export", "", true},
		{"files upload POST", "POST", "/servers/a/files/upload", "", true},
		{"files write POST", "POST", "/servers/a/files/write", "", true},
		{"files zip POST", "POST", "/servers/a/files/zip", "", true},
		{"mods upload POST", "POST", "/servers/a/mods/upload", "", true},
		{"mods install POST", "POST", "/servers/a/mods/install", "", true},
		{"mods install wrong method", "GET", "/servers/a/mods/install", "", false},
		{"mods install outside servers", "POST", "/other/mods/install", "", false},
		{"files download wrong method", "POST", "/servers/a/files/download", "", false},
		{"files write wrong method", "GET", "/servers/a/files/write", "", false},
		{"files archive wrong method", "POST", "/servers/a/files/archive", "", false},
		{"files download outside /servers/", "GET", "/other/files/download", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequestWithContext(context.Background(), tc.method, tc.path, nil)
			if tc.header != "" {
				req.Header.Set("Upgrade", tc.header)
			}
			if got := isStreamingRequest(req); got != tc.want {
				t.Errorf("isStreamingRequest(%s %s, Upgrade=%q) = %v, want %v",
					tc.method, tc.path, tc.header, got, tc.want)
			}
		})
	}
}

// TestIsUploadPath pins the bodyLimit exemption set (F-075): only the
// large-body upload routes under /servers/ skip the 1 MiB cap.
func TestIsUploadPath(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"/servers/a/files/upload", true},
		{"/servers/a/files/write", true},
		{"/servers/a/mods/upload", true},
		{"/other/files/upload", false},
		{"/other/files/write", false},
		{"/other/mods/upload", false},
		{"/servers/a/files/delete", false},
		{"/servers/a/mods", false},
		{"/servers/a/files/download", false},
		{"/servers/a", false},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			if got := isUploadPath(tc.path); got != tc.want {
				t.Errorf("isUploadPath(%q) = %v, want %v", tc.path, got, tc.want)
			}
		})
	}
}

// TestRequestTimeout_NormalRequestCarriesDeadline proves a normal route
// still gets chi's Timeout middleware — the request context has a
// deadline, matching the real DoS protection this middleware exists for.
func TestRequestTimeout_NormalRequestCarriesDeadline(t *testing.T) {
	mw := requestTimeout(30 * time.Second)
	var sawDeadline bool
	h := mw(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, sawDeadline = r.Context().Deadline()
	}))
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/servers/alpha", nil)
	h.ServeHTTP(httptest.NewRecorder(), req)
	if !sawDeadline {
		t.Fatal("normal request context has no deadline, want chi.Timeout applied")
	}
}

// TestRequestTimeout_NormalRequestExpires proves the deadline is real: a
// handler that outlives it gets the standard 504, same as bare
// middleware.Timeout would produce.
func TestRequestTimeout_NormalRequestExpires(t *testing.T) {
	mw := requestTimeout(10 * time.Millisecond)
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
			return
		case <-time.After(200 * time.Millisecond):
			w.WriteHeader(http.StatusOK)
		}
	}))
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/servers/alpha", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusGatewayTimeout {
		t.Fatalf("got %d, want 504 (deadline should have fired)", rr.Code)
	}
}

// TestRequestTimeout_StreamingRequestHasNoDeadline proves the two
// streaming shapes (WebSocket upgrade, /events) bypass chi.Timeout
// entirely — no deadline is imposed on their request context at all, so a
// long-lived connection is never force-closed by this middleware.
func TestRequestTimeout_StreamingRequestHasNoDeadline(t *testing.T) {
	cases := []struct {
		name   string
		method string
		path   string
		header string
	}{
		{"websocket upgrade", "GET", "/ws/servers/alpha/console", "websocket"},
		{"events SSE", "GET", "/events", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mw := requestTimeout(10 * time.Millisecond)
			var hasDeadline bool
			h := mw(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				_, hasDeadline = r.Context().Deadline()
			}))
			req := httptest.NewRequestWithContext(context.Background(), tc.method, tc.path, nil)
			if tc.header != "" {
				req.Header.Set("Upgrade", tc.header)
			}
			h.ServeHTTP(httptest.NewRecorder(), req)
			if hasDeadline {
				t.Fatal("streaming request context has a deadline, want none")
			}
		})
	}
}

// TestRequestTimeout_StreamingRequestOutlivesTimeout proves a streaming
// handler that runs well past the configured deadline is never force
// gateway-timed-out — the exact regression this middleware fixes (SSE
// connections killed every 60s).
func TestRequestTimeout_StreamingRequestOutlivesTimeout(t *testing.T) {
	mw := requestTimeout(10 * time.Millisecond)
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(50 * time.Millisecond) // well past the configured deadline
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/events", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (streaming route must not be cut off at the deadline)", rr.Code)
	}
}
