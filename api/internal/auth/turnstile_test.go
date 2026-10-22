package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTurnstileMiddleware(t *testing.T) {
	cloudflare := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.PostForm.Get("secret") == "secret" && r.PostForm.Get("response") == "good" {
			_, _ = w.Write([]byte(`{"success":true}`))
			return
		}
		_, _ = w.Write([]byte(`{"success":false}`))
	}))
	defer cloudflare.Close()

	turnstile := NewTurnstile("site", "secret")
	turnstile.verifyURL = cloudflare.URL
	handler := turnstile.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for _, tc := range []struct {
		token string
		want  int
	}{
		{"good", http.StatusNoContent},
		{"bad", http.StatusForbidden},
		{"", http.StatusForbidden},
	} {
		req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
		if tc.token != "" {
			req.Header.Set(TurnstileHeader, tc.token)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Errorf("token %q: status %d, want %d", tc.token, rec.Code, tc.want)
		}
	}
}

func TestTurnstileDisabledWithoutBothKeys(t *testing.T) {
	for _, keys := range [][2]string{{"", ""}, {"site", ""}, {"", "secret"}} {
		if NewTurnstile(keys[0], keys[1]) != nil {
			t.Errorf("NewTurnstile(%q, %q) should be disabled", keys[0], keys[1])
		}
	}
}
