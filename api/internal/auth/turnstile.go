package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/GameplanePanel/gameplane/api/internal/httperr"
	"github.com/GameplanePanel/gameplane/api/internal/messages"
)

const (
	turnstileVerifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
	TurnstileHeader    = "CF-Turnstile-Response"
)

type Turnstile struct {
	SiteKey   string
	secret    string
	verifyURL string
	client    *http.Client
}

func NewTurnstile(siteKey, secret string) *Turnstile {
	if siteKey == "" || secret == "" {
		return nil
	}
	return &Turnstile{
		SiteKey:   siteKey,
		secret:    secret,
		verifyURL: turnstileVerifyURL,
		client:    &http.Client{Timeout: 5 * time.Second},
	}
}

func (t *Turnstile) Middleware(next http.Handler) http.Handler {
	if t == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !t.verify(r.Context(), r.Header.Get(TurnstileHeader)) {
			httperr.WriteMessage(w, r, messages.New("server.auth.captcha_failed", nil))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (t *Turnstile) verify(ctx context.Context, token string) bool {
	if token == "" {
		return false
	}
	form := url.Values{"secret": {t.secret}, "response": {token}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.verifyURL, strings.NewReader(form.Encode()))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := t.client.Do(req)
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()
	var result struct {
		Success bool `json:"success"`
	}
	return resp.StatusCode == http.StatusOK && json.NewDecoder(resp.Body).Decode(&result) == nil && result.Success
}
