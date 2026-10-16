package handlers

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAIStreamFrames(t *testing.T) {
	h := &aiHandler{}
	ch, snapshot, done := h.subscribe("c1")
	if snapshot != "" {
		t.Fatalf("snapshot = %q, want empty", snapshot)
	}
	h.pushText("c1", "Hel")
	if got := string(<-ch); got != `{"text":"Hel"}` {
		t.Errorf("first frame = %s", got)
	}
	h.pushText("c1", "lo")
	select {
	case got := <-ch:
		t.Errorf("unthrottled frame = %s", got)
	default:
	}
	_, snapshot, late := h.subscribe("c1")
	if snapshot != "Hello" {
		t.Errorf("late snapshot = %q", snapshot)
	}
	h.pushFlush("c1")
	if got := string(<-ch); got != `{"flush":true}` {
		t.Errorf("flush frame = %s", got)
	}
	h.pushText("c1", "next")
	if got := string(<-ch); got != `{"text":"next"}` {
		t.Errorf("frame after flush = %s", got)
	}
	h.pushFlush("c1")
	<-ch
	done()
	late()
	h.streamMu.Lock()
	left := len(h.streams)
	h.streamMu.Unlock()
	if left != 0 {
		t.Errorf("streams left = %d, want 0", left)
	}
}

func TestAIStreamLatestFrameWins(t *testing.T) {
	h := &aiHandler{}
	ch, _, done := h.subscribe("c1")
	defer done()
	h.pushText("c1", "one")
	h.pushFlush("c1")
	if got := string(<-ch); got != `{"flush":true}` {
		t.Errorf("queued frame = %s, want the newest", got)
	}
}

func TestAIStreamReplyText(t *testing.T) {
	f := newAIFixture(t, true)
	f.block = make(chan struct{})
	f.deltas = []string{"Hello", " world"}
	f.script(nil, textReply("Hello world", "end_turn"))
	conv := f.create(map[string]any{"prompt": "hi"})
	if text := f.waitStream(conv.ID); text != "Hello world" {
		t.Fatalf("streamed text = %q", text)
	}
	ch, snapshot, done := f.h.subscribe(conv.ID)
	defer done()
	if snapshot != "Hello world" {
		t.Errorf("snapshot = %q", snapshot)
	}
	f.mu.Lock()
	close(f.block)
	f.block, f.deltas = nil, nil
	f.mu.Unlock()
	f.wait(conv.ID, aiIdle)
	if got := string(<-ch); got != `{"flush":true}` {
		t.Errorf("frame after the reply was saved = %s", got)
	}
	f.h.streamMu.Lock()
	live := f.h.streams[conv.ID]
	f.h.streamMu.Unlock()
	if live == nil || live.text != "" {
		t.Errorf("stream after flush = %+v, want empty text", live)
	}
}

func TestAIStreamSSE(t *testing.T) {
	f := newAIFixture(t, true)
	f.script(nil, textReply("ok", "end_turn"))
	conv := f.create(map[string]any{"prompt": "hi"})
	f.wait(conv.ID, aiIdle)
	f.h.pushText(conv.ID, "partial reply")

	srv := httptest.NewServer(f.r)
	defer srv.Close()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/ai/conversations/"+conv.ID+"/stream", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("Cookie", "gameplane_session=s1")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("stream status = %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("content type = %q", ct)
	}
	reader := bufio.NewReader(resp.Body)
	if line := readFrame(t, reader); line != `data: {"text":"partial reply"}` {
		t.Errorf("snapshot frame = %q", line)
	}
	f.h.pushFlush(conv.ID)
	if line := readFrame(t, reader); line != `data: {"flush":true}` {
		t.Errorf("live frame = %q", line)
	}
	cancel()

	if rr := f.do(http.MethodGet, "/ai/conversations/"+conv.ID+"/stream", "bob", nil); rr.Code != http.StatusNotFound {
		t.Errorf("stream for another user = %d", rr.Code)
	}
	if rr := f.do(http.MethodGet, "/ai/conversations/missing/stream", "", nil); rr.Code != http.StatusNotFound {
		t.Errorf("stream for an unknown conversation = %d", rr.Code)
	}
}

func readFrame(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read frame: %v", err)
		}
		if line = strings.TrimRight(line, "\n"); line != "" {
			return line
		}
	}
}

func TestAICLIDelta(t *testing.T) {
	cases := []struct{ raw, want string }{
		{`{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}`, "hi"},
		{`{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}`, ""},
		{`{"type":"message_stop"}`, ""},
		{`not json`, ""},
	}
	for _, tc := range cases {
		if got := aiCLIDelta([]byte(tc.raw)); got != tc.want {
			t.Errorf("aiCLIDelta(%s) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}
