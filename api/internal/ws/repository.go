package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/httperr"
	"github.com/GameplanePanel/gameplane/api/internal/messages"
	"github.com/GameplanePanel/gameplane/api/internal/rbac"
)

// GitCredentials is the acting user's GitHub token and commit identity.
type GitCredentials struct {
	Token string
	Name  string
	Email string
}

// GitCredentialSource looks up a user's GitHub credentials.
type GitCredentialSource func(ctx context.Context, userID int64) (GitCredentials, bool)

const (
	gitAuthHeader        = "X-Gameplane-Git-Token"
	gitAuthorNameHeader  = "X-Gameplane-Git-Author-Name"
	gitAuthorEmailHeader = "X-Gameplane-Git-Author-Email"
	repoAgentBody        = 1 << 20
)

var (
	repoUIDPattern = regexp.MustCompile(`^[a-zA-Z0-9-]{1,128}$`)
	repoSHAPattern = regexp.MustCompile(`^[0-9a-f]{4,64}$`)
)

type gitCreds int

const (
	gitNone gitCreds = iota
	gitToken
	gitAuthor
	gitTokenAuthor
	gitTokenOptionalAuthor
)

// RepoAgent proxies repository files and Git routes to a repository's
// agent and reads its token-free clone and status endpoints.
type RepoAgent struct {
	transport agentTransport
	creds     GitCredentialSource
}

// NewRepoAgent builds the repository agent client from the agent mTLS
// material; without it every call answers 503.
func NewRepoAgent(caBundle, clientCert, clientKey string, creds GitCredentialSource) *RepoAgent {
	agent := &RepoAgent{creds: creds}
	if tlsCfg, err := agentTLSConfig(caBundle, clientCert, clientKey); err == nil {
		agent.transport = newDirectAgentTransport(tlsCfg, 0)
	}
	return agent
}

// Mount wires /repositories/{name}/files/* and /repositories/{name}/git/*.
func (a *RepoAgent) Mount(r chi.Router) {
	r.Route("/repositories/{name}/files", func(r chi.Router) {
		for _, op := range []string{"list", "size", "read", "download", "archive"} {
			r.Get("/"+op, a.proxy("/files/"+op, gitNone, 0))
		}
		for _, op := range []string{"write", "create", "upload", "mkdir", "zip"} {
			r.Post("/"+op, a.proxy("/files/"+op, gitNone, 64<<20))
		}
		r.Delete("/delete", a.proxy("/files/delete", gitNone, 0))
	})
	r.Route("/repositories/{name}/git", func(r chi.Router) {
		for _, op := range []string{"status", "diff", "log", "branches"} {
			r.Get("/"+op, a.proxy("/git/"+op, gitNone, 0))
		}
		r.Get("/commits/{sha}", a.commitProxy())
		for _, op := range []string{"stage", "unstage", "discard", "undo", "branches", "checkout"} {
			r.Post("/"+op, a.proxy("/git/"+op, gitNone, repoAgentBody))
		}
		r.Post("/commit", a.proxy("/git/commit", gitTokenAuthor, repoAgentBody))
		r.Post("/revert", a.proxy("/git/revert", gitAuthor, repoAgentBody))
		r.Post("/fetch", a.proxy("/git/fetch", gitToken, repoAgentBody))
		r.Post("/pull", a.proxy("/git/pull", gitTokenOptionalAuthor, repoAgentBody))
		r.Post("/push", a.proxy("/git/push", gitToken, repoAgentBody))
	})
}

func (a *RepoAgent) commitProxy() http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		sha := chi.URLParam(req, "sha")
		if !repoSHAPattern.MatchString(sha) {
			writeGitError(w, http.StatusBadRequest, "bad_request", nil)
			return
		}
		a.proxy("/git/commits/"+sha, gitNone, 0)(w, req)
	}
}

func repoTarget(grant rbac.RepositoryGrant, agentPath string) (agentTarget, string, error) {
	target := agentTarget{name: grant.Identity.Name, namespace: grant.Identity.Namespace}
	if err := target.validate(); err != nil || !repoUIDPattern.MatchString(grant.Identity.UID) {
		return agentTarget{}, "", errors.New("invalid repository target")
	}
	return target, "/v1/targets/" + grant.Identity.UID + agentPath, nil
}

func (a *RepoAgent) proxy(agentPath string, mode gitCreds, maxBody int64) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		grant, ok := rbac.RepositoryGrantFrom(req.Context())
		if !ok {
			httperr.WriteMessage(w, req, messages.New(httperr.IDNotFound, nil))
			return
		}
		target, path, err := repoTarget(grant, agentPath)
		if err != nil {
			httperr.WriteCode(w, req, http.StatusBadRequest, err)
			return
		}
		var body io.Reader = http.NoBody
		if maxBody > 0 {
			body = http.MaxBytesReader(w, req.Body, maxBody)
		}
		needToken := mode == gitToken || mode == gitTokenAuthor || mode == gitTokenOptionalAuthor
		if agentPath == "/git/commit" {
			raw, err := io.ReadAll(body)
			if err != nil {
				writeGitError(w, http.StatusRequestEntityTooLarge, "too_large", nil)
				return
			}
			var commit struct {
				Push bool `json:"push"`
			}
			_ = json.Unmarshal(raw, &commit)
			if commit.Push && !grant.Has(rbac.RepoPush) {
				httperr.WriteMessage(w, req, messages.New(httperr.IDForbidden, nil))
				return
			}
			needToken, body = commit.Push, bytes.NewReader(raw)
		}
		extra := http.Header{}
		if mode != gitNone {
			creds, ok := a.lookup(req)
			if !ok && (needToken || mode == gitAuthor || mode == gitTokenAuthor) {
				writeGitError(w, http.StatusPreconditionRequired, "github_token_required", nil)
				return
			}
			if ok && needToken {
				extra.Set(gitAuthHeader, creds.Token)
			}
			if ok && mode != gitToken {
				extra.Set(gitAuthorNameHeader, creds.Name)
				extra.Set(gitAuthorEmailHeader, creds.Email)
			}
		}
		if a.transport == nil {
			http.Error(w, "agent mTLS not configured", http.StatusServiceUnavailable)
			return
		}
		resp, err := a.transport.Do(req.Context(), agentRequest{
			target: target, method: req.Method, path: path,
			rawQuery: req.URL.RawQuery, header: req.Header, extra: extra, body: body,
		})
		if err != nil {
			writeUpstreamErr(w, req, err)
			return
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode >= http.StatusBadRequest && (strings.HasPrefix(agentPath, "/git/") || resp.StatusCode == http.StatusForbidden) {
			relayGitError(w, req, resp)
			return
		}
		copyResponseHeaders(w.Header(), resp.Header)
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}
}

func (a *RepoAgent) lookup(req *http.Request) (GitCredentials, bool) {
	u := auth.UserFromContext(req.Context())
	if u == nil || a.creds == nil {
		return GitCredentials{}, false
	}
	return a.creds(req.Context(), u.ID)
}

type agentGitError struct {
	Code    string          `json:"code"`
	Output  string          `json:"output,omitempty"`
	Files   []string        `json:"files,omitempty"`
	Commit  json.RawMessage `json:"commit,omitempty"`
	Message string          `json:"message"`
}

func relayGitError(w http.ResponseWriter, req *http.Request, resp *http.Response) {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	var agentErr agentGitError
	if json.Unmarshal(raw, &agentErr) != nil || agentErr.Code == "" {
		agentErr.Code = strings.TrimSpace(string(raw))
	}
	if resp.StatusCode >= http.StatusInternalServerError {
		slog.Warn("repository agent error", "path", req.URL.Path, "status", resp.StatusCode, "code", agentErr.Code, "message", agentErr.Message)
		agentErr = agentGitError{Code: "internal"}
	}
	writeGitError(w, resp.StatusCode, agentErr.Code, &agentErr)
}

func writeGitError(w http.ResponseWriter, status int, code string, detail *agentGitError) {
	id := messages.ID("server.repositories." + code)
	if _, known := messages.Lookup(id); !known {
		id, code = messages.ID(httperr.GenericID(status)), "error"
	}
	msg := messages.New(id, nil)
	body := map[string]any{
		"type": "about:blank", "status": status, "title": http.StatusText(status),
		"detail": msg.English, "messageId": string(id), "args": map[string]any{}, "code": code,
	}
	if detail != nil {
		if detail.Output != "" {
			body["output"] = detail.Output
		}
		if len(detail.Files) > 0 {
			body["files"] = detail.Files
		}
		if len(detail.Commit) > 0 {
			body["commit"] = detail.Commit
		}
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// RepoClone is the clone progress the repository agent reports.
type RepoClone struct {
	State    string `json:"state"`
	Progress int    `json:"progress"`
	Error    *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// RepoStatus is the working-copy summary the repository agent reports.
type RepoStatus struct {
	Branch   string            `json:"branch"`
	Head     *string           `json:"head"`
	Upstream *string           `json:"upstream"`
	Ahead    int               `json:"ahead"`
	Behind   int               `json:"behind"`
	Changes  []json.RawMessage `json:"changes"`
}

// Live reads the agent's clone state and, when the working copy is a Git
// repository, its status. Neither call carries a token.
func (a *RepoAgent) Live(ctx context.Context, ns, name, uid string) (RepoClone, *RepoStatus, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var clone RepoClone
	if _, err := a.call(ctx, ns, name, uid, http.MethodGet, "/git/clone", nil, nil, &clone); err != nil {
		return clone, nil, err
	}
	var status RepoStatus
	code, err := a.call(ctx, ns, name, uid, http.MethodGet, "/git/status", nil, nil, &status)
	if err != nil || code != http.StatusOK {
		return clone, nil, err
	}
	return clone, &status, nil
}

// Clone starts a clone of url into the repository's working copy with the
// caller's token; wipe replaces an existing working copy.
func (a *RepoAgent) Clone(ctx context.Context, ns, name, uid, url, branch string, wipe bool, token string) error {
	body, err := json.Marshal(map[string]any{"url": url, "branch": branch, "wipe": wipe})
	if err != nil {
		return fmt.Errorf("encode clone: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	code, err := a.call(ctx, ns, name, uid, http.MethodPost, "/git/clone", http.Header{gitAuthHeader: {token}}, body, nil)
	if err != nil {
		return err
	}
	if code != http.StatusAccepted {
		return fmt.Errorf("agent clone: status %d", code)
	}
	return nil
}

func (a *RepoAgent) call(ctx context.Context, ns, name, uid, method, agentPath string, extra http.Header, body []byte, out any) (int, error) {
	if a.transport == nil {
		return 0, errors.New("agent mTLS not configured")
	}
	target, path, err := repoTarget(rbac.RepositoryGrant{Identity: rbac.ServerIdentity{Namespace: ns, Name: name, UID: uid}}, agentPath)
	if err != nil {
		return 0, err
	}
	resp, err := a.transport.Do(ctx, agentRequest{
		target: target, method: method, path: path, body: bytes.NewReader(body), extra: extra,
		header: http.Header{"Accept": {"application/json"}, "Content-Type": {"application/json"}},
	})
	if err != nil {
		return 0, fmt.Errorf("agent %s %s: %w", method, agentPath, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if out != nil && resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(io.LimitReader(resp.Body, agentRespCap)).Decode(out); err != nil {
			return resp.StatusCode, fmt.Errorf("agent %s %s: decode: %w", method, agentPath, err)
		}
	}
	return resp.StatusCode, nil
}
