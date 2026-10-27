package handlers

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/httperr"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
	"github.com/GameplanePanel/gameplane/api/internal/messages"
	"github.com/GameplanePanel/gameplane/api/internal/ws"
)

const (
	githubSecretPrefix = "gameplane-github-"
	githubSecretLabel  = "gameplane.local/github-token"
	githubAPI          = "https://api.github.com"
)

// GitHubTokens keeps each user's GitHub token and the identity GitHub
// reported for it in a labelled Secret of their own.
type GitHubTokens struct {
	k      *kube.Client
	ns     string
	api    string
	client *http.Client
}

// NewGitHubTokens returns the per-user GitHub token store in the control namespace.
func NewGitHubTokens(k *kube.Client, controlNS string) GitHubTokens {
	return GitHubTokens{k: k, ns: controlNS, api: githubAPI, client: &http.Client{Timeout: 15 * time.Second}}
}

type githubAccount struct {
	token     string
	login     string
	name      string
	id        int64
	contents  string
	workflows string
}

func (s GitHubTokens) name(user int64) string {
	return githubSecretPrefix + strconv.FormatInt(user, 10)
}

func (s GitHubTokens) account(ctx context.Context, user int64) (githubAccount, bool) {
	secrets := s.k.Secrets(s.ns)
	if secrets == nil {
		return githubAccount{}, false
	}
	sec, err := secrets.Get(ctx, s.name(user), metav1.GetOptions{})
	if err != nil || sec.Labels[githubSecretLabel] != "true" || len(sec.Data["token"]) == 0 {
		return githubAccount{}, false
	}
	id, _ := strconv.ParseInt(string(sec.Data["id"]), 10, 64)
	return githubAccount{
		token: string(sec.Data["token"]), login: string(sec.Data["login"]), name: string(sec.Data["name"]), id: id,
		contents: string(sec.Data["contents"]), workflows: string(sec.Data["workflows"]),
	}, true
}

// Credentials returns the user's token and commit identity for the repo agent proxy.
func (s GitHubTokens) Credentials(ctx context.Context, user int64) (ws.GitCredentials, bool) {
	account, ok := s.account(ctx, user)
	if !ok {
		return ws.GitCredentials{}, false
	}
	return ws.GitCredentials{
		Token: account.token,
		Name:  cmp.Or(account.name, account.login),
		Email: fmt.Sprintf("%d+%s@users.noreply.github.com", account.id, account.login),
	}, true
}

func (s GitHubTokens) verify(ctx context.Context, token string) (githubAccount, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.api+"/user", nil)
	if err != nil {
		return githubAccount{}, fmt.Errorf("github request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := s.client.Do(req)
	if err != nil {
		return githubAccount{}, fmt.Errorf("github user: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return githubAccount{}, fmt.Errorf("github user: status %d", resp.StatusCode)
	}
	var user struct {
		Login string `json:"login"`
		Name  string `json:"name"`
		ID    int64  `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&user); err != nil || user.Login == "" || user.ID == 0 {
		return githubAccount{}, errors.New("github user: unexpected response")
	}
	account := githubAccount{token: token, login: user.Login, name: user.Name, id: user.ID}
	if header, classic := resp.Header["X-Oauth-Scopes"]; classic {
		scopes := strings.Split(strings.ReplaceAll(strings.Join(header, ","), " ", ""), ",")
		account.contents, account.workflows = "none", strconv.FormatBool(slices.Contains(scopes, "workflow"))
		if slices.Contains(scopes, "repo") || slices.Contains(scopes, "public_repo") {
			account.contents = "write"
		}
	}
	return account, nil
}

// MountGitHubIntegration wires the caller's own GitHub token routes.
func MountGitHubIntegration(r chi.Router, tokens GitHubTokens) {
	r.Get("/integrations/github", tokens.get)
	r.Put("/integrations/github/token", tokens.put)
	r.Delete("/integrations/github/token", tokens.del)
}

func (s GitHubTokens) get(w http.ResponseWriter, req *http.Request) {
	writeJSON(w, githubView(s.account(req.Context(), auth.UserFromContext(req.Context()).ID)))
}

func githubView(account githubAccount, ok bool) map[string]any {
	out := map[string]any{"keySet": ok, "keyHint": "", "login": nil, "name": nil, "contents": nil, "workflows": nil}
	if ok {
		out["keyHint"], out["login"], out["name"] = account.token[max(len(account.token)-4, 0):], account.login, cmp.Or(account.name, account.login)
		if account.contents != "" {
			out["contents"], out["workflows"] = account.contents, account.workflows == "true"
		}
	}
	return out
}

func (s GitHubTokens) put(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		httperr.WriteMessage(w, req, messages.New("server.common.invalid_json", nil))
		return
	}
	token := strings.TrimSpace(body.Token)
	if token == "" || strings.ContainsAny(token, " \r\n\t") {
		httperr.WriteMessage(w, req, messages.New("server.repositories.token_invalid", nil))
		return
	}
	account, err := s.verify(req.Context(), token)
	if err != nil {
		httperr.WriteMessage(w, req, messages.New("server.repositories.token_invalid", nil))
		return
	}
	user := auth.UserFromContext(req.Context()).ID
	err = upsertLabelledSecret(req.Context(), s.k, s.ns, s.name(user), githubSecretLabel, map[string]string{
		"token": token, "login": account.login, "name": account.name, "id": strconv.FormatInt(account.id, 10),
		"contents": account.contents, "workflows": account.workflows,
	})
	if errors.Is(err, errNotManagedSecret) {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	writeJSON(w, githubView(account, true))
}

func (s GitHubTokens) del(w http.ResponseWriter, req *http.Request) {
	err := deleteManagedSecret(req.Context(), s.k, s.ns, s.name(auth.UserFromContext(req.Context()).ID), githubSecretLabel)
	if err != nil && !apierrors.IsNotFound(err) {
		httperr.Write(w, req, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
