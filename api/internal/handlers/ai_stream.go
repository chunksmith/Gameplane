package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const (
	aiDeltaGap   = 60 * time.Millisecond
	aiStreamPing = 25 * time.Second
)

type aiFrame struct {
	Text  string `json:"text,omitempty"`
	Flush bool   `json:"flush,omitempty"`
}

type aiStream struct {
	text string
	last time.Time
	subs map[chan []byte]struct{}
}

func (s *aiStream) publish(frame aiFrame) {
	data, err := json.Marshal(frame)
	if err != nil {
		return
	}
	for ch := range s.subs {
		select {
		case <-ch:
		default:
		}
		select {
		case ch <- data:
		default:
		}
	}
}

func (h *aiHandler) streamFor(id string) *aiStream {
	if h.streams == nil {
		h.streams = map[string]*aiStream{}
	}
	s := h.streams[id]
	if s == nil {
		s = &aiStream{subs: map[chan []byte]struct{}{}}
		h.streams[id] = s
	}
	return s
}

func (h *aiHandler) pushText(id, delta string) {
	if delta == "" {
		return
	}
	h.streamMu.Lock()
	defer h.streamMu.Unlock()
	s := h.streamFor(id)
	s.text += delta
	if time.Since(s.last) < aiDeltaGap {
		return
	}
	s.last = time.Now()
	s.publish(aiFrame{Text: s.text})
}

func (h *aiHandler) pushFlush(id string) {
	h.streamMu.Lock()
	defer h.streamMu.Unlock()
	s := h.streams[id]
	if s == nil {
		return
	}
	s.text, s.last = "", time.Time{}
	s.publish(aiFrame{Flush: true})
	if len(s.subs) == 0 {
		delete(h.streams, id)
	}
}

func (h *aiHandler) subscribe(id string) (chan []byte, string, func()) {
	ch := make(chan []byte, 1)
	h.streamMu.Lock()
	defer h.streamMu.Unlock()
	s := h.streamFor(id)
	s.subs[ch] = struct{}{}
	return ch, s.text, func() {
		h.streamMu.Lock()
		defer h.streamMu.Unlock()
		delete(s.subs, ch)
		if len(s.subs) == 0 && s.text == "" && h.streams[id] == s {
			delete(h.streams, id)
		}
	}
}

func (h *aiHandler) sse(w http.ResponseWriter, req *http.Request) {
	conv, ok := h.load(w, req, false)
	if !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	ch, text, unsubscribe := h.subscribe(conv.ID)
	defer unsubscribe()
	flusher.Flush()
	if text != "" {
		data, _ := json.Marshal(aiFrame{Text: text})
		if !aiSSE(w, flusher, data) {
			return
		}
	}
	ping := time.NewTicker(aiStreamPing)
	defer ping.Stop()
	for {
		select {
		case <-req.Context().Done():
			return
		case data := <-ch:
			if !aiSSE(w, flusher, data) {
				return
			}
		case <-ping.C:
			if !aiSSE(w, flusher, nil) {
				return
			}
		}
	}
}

func aiSSE(w http.ResponseWriter, flusher http.Flusher, data []byte) bool {
	var err error
	if data == nil {
		_, err = fmt.Fprint(w, ": ping\n\n")
	} else {
		_, err = fmt.Fprintf(w, "data: %s\n\n", data)
	}
	flusher.Flush()
	return err == nil
}
