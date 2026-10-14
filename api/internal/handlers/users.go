package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/mail"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/db"
	"github.com/GameplanePanel/gameplane/api/internal/httperr"
	"github.com/GameplanePanel/gameplane/api/internal/rbac"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

// MountUsers registers the user management API handlers.
func MountUsers(r chi.Router, store *db.Store, sessions *auth.SessionStore, clusters scope.ClusterLister) {
	h := &userHandler{db: store, sessions: sessions, clusters: clusters}
	r.Route("/users", func(r chi.Router) {
		r.Get("/", h.list)
		r.Post("/", h.create)
		r.Get("/me", h.me)
		r.Get("/me/preferences", h.getPreferences)
		r.Put("/me/preferences", h.putPreferences)
		r.Post("/me/preferences/reset", h.resetPreferences)
		r.Delete("/{id}", h.del)
		r.Patch("/{id}", h.update)
		r.Post("/{id}/reset-password", h.resetPassword)
		// Supplemental namespace and restricted remote-wide grants. The local
		// cluster-wide binding remains the primary role, set via PATCH above.
		r.Get("/{id}/bindings", h.listBindings)
		r.Post("/{id}/bindings", h.addBinding)
		r.Delete("/{id}/bindings/{role}/{namespace}", h.deleteBinding)
	})
	mountNetworks(r, store)
}

type userHandler struct {
	db       *db.Store
	sessions *auth.SessionStore
	clusters scope.ClusterLister
}

type userDTO struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
	Role        string `json:"role"`
	Provider    string `json:"provider"`
	CreatedAt   string `json:"createdAt"`
	// Permissions is the caller's effective permission set, keyed by
	// namespace ("*" = cluster-wide). Populated only on /users/me; it
	// drives the dashboard's can()-based UI gating.
	Permissions map[string][]string `json:"permissions,omitempty"`
	// PermissionsByCluster is the caller's effective permission set partitioned
	// by cluster, allowing the frontend to determine cluster-specific access.
	// Structure is cluster → namespace → sorted []permission. Populated only on
	// /users/me, mirroring the structure returned by SessionStore.LoadPerms.
	// Enables the frontend's can() function to exactly replicate User.Can()
	// without triggering 403 errors on multi-cluster deployments.
	PermissionsByCluster map[string]map[string][]string `json:"permissionsByCluster,omitempty"`
	// Preferences is the caller's theme/styling preferences. Populated only
	// on /users/me so the dashboard can apply the theme without a second
	// round-trip on boot (contracts/user-preferences-api.md §1.4).
	Preferences *userPreferencesDTO `json:"preferences,omitempty"`
}

func (h *userHandler) list(w http.ResponseWriter, req *http.Request) {
	rows, err := h.db.DB.QueryContext(req.Context(), `
		SELECT u.id, u.username, u.display_name, u.email, u.role, u.created_at,
		       CASE
		         WHEN EXISTS (SELECT 1 FROM oidc_links l WHERE l.user_id = u.id) THEN 'oidc'
		         WHEN u.pw_hash IS NOT NULL AND u.pw_hash <> ''               THEN 'local'
		         ELSE 'pending'
		       END AS provider
		FROM users u
		ORDER BY u.id`)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []userDTO{}
	for rows.Next() {
		var u userDTO
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.Role, &u.CreatedAt, &u.Provider); err != nil {
			httperr.Write(w, req, err)
			return
		}
		u.CreatedAt = db.NormalizeTimestamp(u.CreatedAt)
		out = append(out, u)
	}
	writeJSON(w, out)
}

type createUserReq struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
	Password    string `json:"password"`
	Role        string `json:"role"`
}

func (h *userHandler) create(w http.ResponseWriter, req *http.Request) {
	var body createUserReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !identifierRE.MatchString(body.Username) {
		http.Error(w, "invalid username", http.StatusBadRequest)
		return
	}
	if body.Email != "" {
		if _, err := mail.ParseAddress(body.Email); err != nil {
			http.Error(w, "invalid email", http.StatusBadRequest)
			return
		}
	}
	if body.Role == "" {
		body.Role = rbac.RoleMember
	}
	if ok, err := h.db.RoleExists(req.Context(), body.Role); err != nil {
		httperr.Write(w, req, err)
		return
	} else if !ok {
		http.Error(w, "invalid role", http.StatusBadRequest)
		return
	}
	var hash string
	if body.Password != "" {
		if len(body.Password) < auth.MinPasswordLen {
			http.Error(w, "password too short", http.StatusBadRequest)
			return
		}
		h2, err := auth.HashPassword(req.Context(), body.Password)
		if err != nil {
			httperr.Write(w, req, err)
			return
		}
		hash = h2
	}
	// RETURNING id instead of LastInsertId: pgx's database/sql driver has
	// no LastInsertId, and both SQLite and Postgres support RETURNING.
	var id int64
	var createdAt string
	if err := h.db.DB.QueryRowContext(req.Context(),
		`INSERT INTO users(username, display_name, email, role, pw_hash) VALUES (?, ?, ?, ?, ?) RETURNING id, created_at`,
		body.Username, body.DisplayName, body.Email, body.Role, nullable(hash),
	).Scan(&id, &createdAt); err != nil {
		httperr.Write(w, req, err)
		return
	}
	// Mirror the primary role into a cluster-wide ("*") role binding so
	// RBAC resolves the new user's permissions. Without this the user has
	// no effective permissions at all.
	if err := h.db.SetClusterRoleBinding(req.Context(), nil, id, scope.DefaultCluster, body.Role); err != nil {
		httperr.Write(w, req, err)
		return
	}
	provider := "pending"
	if hash != "" {
		provider = "local"
	}
	writeJSON(w, userDTO{
		ID: id, Username: body.Username, DisplayName: body.DisplayName,
		Email: body.Email, Role: body.Role, Provider: provider,
		CreatedAt: db.NormalizeTimestamp(createdAt),
	})
}

func (h *userHandler) me(w http.ResponseWriter, req *http.Request) {
	u := auth.UserFromContext(req.Context())
	if u == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	prefs, err := h.db.GetPreferences(req.Context(), u.ID)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	writeJSON(w, userDTO{
		ID: u.ID, Username: u.Username, DisplayName: u.DisplayName,
		Email: u.Email, Role: u.Role, Permissions: auth.PermsToJSON(u.Perms),
		PermissionsByCluster: auth.PermsByClusterToJSON(u.Perms),
		Preferences:          preferencesDTO(prefs),
	})
}

// customColorsDTO is the optional custom color pair applied when the base
// mode is custom_colors.
type customColorsDTO struct {
	Accent  string `json:"accent"`
	Surface string `json:"surface"`
}

// userPreferencesDTO is the API shape of a user's theme/styling preferences
// (contracts/user-preferences-api.md §1).
type userPreferencesDTO struct {
	ThemeType        string           `json:"themeType"`
	PresetID         string           `json:"presetId"`
	AppearanceMode   string           `json:"appearanceMode"`
	CustomColors     *customColorsDTO `json:"customColors"`
	CustomCSSEnabled bool             `json:"customCssEnabled"`
	CustomCSS        *string          `json:"customCss"`
	UpdatedAt        string           `json:"updatedAt"`
}

func preferencesDTO(p db.UserPreferences) *userPreferencesDTO {
	out := &userPreferencesDTO{
		ThemeType:        p.ThemeType,
		PresetID:         p.PresetID,
		AppearanceMode:   p.AppearanceMode,
		CustomCSSEnabled: p.CustomCSSEnabled,
		CustomCSS:        p.CustomCSS,
		UpdatedAt:        p.UpdatedAt,
	}
	if p.CustomAccent != nil || p.CustomSurface != nil {
		out.CustomColors = &customColorsDTO{}
		if p.CustomAccent != nil {
			out.CustomColors.Accent = *p.CustomAccent
		}
		if p.CustomSurface != nil {
			out.CustomColors.Surface = *p.CustomSurface
		}
	}
	return out
}

// FR-013 custom CSS limits (contracts/user-preferences-api.md §1.2). A
// rejected stylesheet returns 400 with a message naming the offending rule.
const maxCustomCSSLen = 32768

var (
	// cssImportRE matches an @import rule anywhere in the stylesheet.
	cssImportRE = regexp.MustCompile(`(?i)@import\b`)
	// cssURLRE captures the reference inside each url(...) so it can be
	// inspected; surrounding quotes are optional and excluded.
	cssURLRE = regexp.MustCompile(`(?i)url\(\s*["']?([^"')]*)["']?\s*\)`)
)

// sanitizeCustomCSS applies the FR-013 rules to a submitted stylesheet,
// returning "" when the CSS is acceptable or a caller-safe message naming
// the offending rule. It rejects oversized payloads, @import rules,
// external url() references (absolute http(s) or protocol-relative, remote
// fonts included) while allowing inline data: URIs, unbalanced braces, and
// anything smuggling HTML <style>/<script> delimiters.
func sanitizeCustomCSS(css string) string {
	if len(css) > maxCustomCSSLen {
		return fmt.Sprintf("customCss rejected: exceeds the maximum length of %d characters", maxCustomCSSLen)
	}
	if cssImportRE.MatchString(css) {
		return "customCss rejected: @import rules are not allowed"
	}
	for _, m := range cssURLRE.FindAllStringSubmatch(css, -1) {
		ref := strings.TrimSpace(m[1])
		lower := strings.ToLower(ref)
		if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") || strings.HasPrefix(ref, "//") {
			return fmt.Sprintf("customCss rejected: external url() reference '%s' is not allowed", ref)
		}
	}
	if strings.Count(css, "{") != strings.Count(css, "}") {
		return "customCss rejected: unbalanced braces"
	}
	lower := strings.ToLower(css)
	for _, d := range []string{"<style", "</style", "<script", "</script"} {
		if strings.Contains(lower, d) {
			return fmt.Sprintf("customCss rejected: HTML delimiter %q is not allowed", d)
		}
	}
	return ""
}

func (h *userHandler) getPreferences(w http.ResponseWriter, req *http.Request) {
	u := auth.UserFromContext(req.Context())
	if u == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	prefs, err := h.db.GetPreferences(req.Context(), u.ID)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	writeJSON(w, preferencesDTO(prefs))
}

// updatePreferencesReq carries a PUT merge: nil means "leave unchanged".
// themeType/presetId/appearanceMode/customCssEnabled are required; the
// optional customColors/customCss fields keep their stored values when
// omitted (FR-012 retention — only reset clears them).
type updatePreferencesReq struct {
	ThemeType        *string          `json:"themeType"`
	PresetID         *string          `json:"presetId"`
	AppearanceMode   *string          `json:"appearanceMode"`
	CustomColors     *customColorsReq `json:"customColors"`
	CustomCSSEnabled *bool            `json:"customCssEnabled"`
	CustomCSS        *string          `json:"customCss"`
}

type customColorsReq struct {
	Accent  *string `json:"accent"`
	Surface *string `json:"surface"`
}

func (h *userHandler) putPreferences(w http.ResponseWriter, req *http.Request) {
	u := auth.UserFromContext(req.Context())
	if u == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	var body updatePreferencesReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.ThemeType == nil {
		http.Error(w, "themeType is required", http.StatusBadRequest)
		return
	}
	if *body.ThemeType != "preset" && *body.ThemeType != "custom_colors" {
		http.Error(w, `themeType must be "preset" or "custom_colors"`, http.StatusBadRequest)
		return
	}
	if body.PresetID == nil {
		http.Error(w, "presetId is required", http.StatusBadRequest)
		return
	}
	if *body.PresetID != "pink" && *body.PresetID != "legacy" {
		http.Error(w, `presetId must be "pink" or "legacy"`, http.StatusBadRequest)
		return
	}
	if body.AppearanceMode == nil {
		http.Error(w, "appearanceMode is required", http.StatusBadRequest)
		return
	}
	if *body.AppearanceMode != "light" && *body.AppearanceMode != "dark" && *body.AppearanceMode != "system" {
		http.Error(w, `appearanceMode must be "light", "dark" or "system"`, http.StatusBadRequest)
		return
	}
	if body.CustomCSSEnabled == nil {
		http.Error(w, "customCssEnabled is required", http.StatusBadRequest)
		return
	}
	if body.CustomColors != nil {
		if body.CustomColors.Accent != nil && !hexColorRE.MatchString(*body.CustomColors.Accent) {
			http.Error(w, "customColors.accent must be a #RRGGBB hex color", http.StatusBadRequest)
			return
		}
		if body.CustomColors.Surface != nil && !hexColorRE.MatchString(*body.CustomColors.Surface) {
			http.Error(w, "customColors.surface must be a #RRGGBB hex color", http.StatusBadRequest)
			return
		}
	}
	if body.CustomCSS != nil {
		if msg := sanitizeCustomCSS(*body.CustomCSS); msg != "" {
			http.Error(w, msg, http.StatusBadRequest)
			return
		}
	}

	// FR-012 retention: read the stored row (or defaults), then apply only
	// the fields present in the body. Omitted customColors/customCss ride
	// along with their stored values; an ordinary update can never null them.
	prefs, err := h.db.GetPreferences(req.Context(), u.ID)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	prefs.ThemeType = *body.ThemeType
	prefs.PresetID = *body.PresetID
	prefs.AppearanceMode = *body.AppearanceMode
	prefs.CustomCSSEnabled = *body.CustomCSSEnabled
	if body.CustomColors != nil {
		if body.CustomColors.Accent != nil {
			prefs.CustomAccent = body.CustomColors.Accent
		}
		if body.CustomColors.Surface != nil {
			prefs.CustomSurface = body.CustomColors.Surface
		}
	}
	if body.CustomCSS != nil {
		prefs.CustomCSS = body.CustomCSS
	}
	saved, err := h.db.UpsertPreferences(req.Context(), u.ID, prefs)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	writeJSON(w, preferencesDTO(saved))
}

// resetPreferencesReq carries the optional preset/appearance to restore;
// nil fields default to the user's current values.
type resetPreferencesReq struct {
	PresetID       *string `json:"presetId"`
	AppearanceMode *string `json:"appearanceMode"`
}

func (h *userHandler) resetPreferences(w http.ResponseWriter, req *http.Request) {
	u := auth.UserFromContext(req.Context())
	if u == nil {
		http.Error(w, "unauthenticated", http.StatusUnauthorized)
		return
	}
	var body resetPreferencesReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Resolve the target preset/appearance from the body, defaulting to the
	// user's current values when omitted (contracts §1.3).
	prefs, err := h.db.GetPreferences(req.Context(), u.ID)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	if body.PresetID != nil {
		if *body.PresetID != "pink" && *body.PresetID != "legacy" {
			http.Error(w, `presetId must be "pink" or "legacy"`, http.StatusBadRequest)
			return
		}
		prefs.PresetID = *body.PresetID
	}
	if body.AppearanceMode != nil {
		if *body.AppearanceMode != "light" && *body.AppearanceMode != "dark" && *body.AppearanceMode != "system" {
			http.Error(w, `appearanceMode must be "light", "dark" or "system"`, http.StatusBadRequest)
			return
		}
		prefs.AppearanceMode = *body.AppearanceMode
	}
	saved, err := h.db.ResetPreferences(req.Context(), u.ID, prefs.PresetID, prefs.AppearanceMode)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	writeJSON(w, preferencesDTO(saved))
}

func (h *userHandler) del(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(req, "id"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	u := auth.UserFromContext(req.Context())
	if u != nil && u.ID == id {
		http.Error(w, "cannot delete self", http.StatusBadRequest)
		return
	}
	// Lock to serialize with writes so the last-user-manager check can't race.
	unlock := h.db.LockUserManagement()
	defer unlock()
	// Don't delete the last user who can manage users.
	if managesNow, err := h.db.UserManagesUsers(req.Context(), id); err != nil {
		httperr.Write(w, req, err)
		return
	} else if managesNow {
		count, err := h.db.UserManagerCount(req.Context())
		if err != nil {
			httperr.Write(w, req, err)
			return
		}
		if count <= 1 {
			http.Error(w, "cannot delete the last user who can manage users", http.StatusBadRequest)
			return
		}
	}
	// One transaction removes the account and every row tied to it (SSO
	// links, preferences, sessions, bindings) and revokes its share links:
	// sqlite runs without FK cascade, so nothing else would.
	if err := h.db.DeleteUser(req.Context(), id); err != nil {
		httperr.Write(w, req, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// updateUserReq carries optional updates. nil means "leave unchanged"
// — pointer-vs-empty-string lets a caller clear an email by sending
// "" without ambiguity.
type updateUserReq struct {
	DisplayName *string `json:"displayName,omitempty"`
	Email       *string `json:"email,omitempty"`
	Role        *string `json:"role,omitempty"`
}

func (h *userHandler) update(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(req, "id"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	var body updateUserReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.Email != nil && *body.Email != "" {
		if _, err := mail.ParseAddress(*body.Email); err != nil {
			http.Error(w, "invalid email", http.StatusBadRequest)
			return
		}
	}
	if body.Role != nil {
		if ok, err := h.db.RoleExists(req.Context(), *body.Role); err != nil {
			httperr.Write(w, req, err)
			return
		} else if !ok {
			http.Error(w, "invalid role", http.StatusBadRequest)
			return
		}
	}
	caller := auth.UserFromContext(req.Context())
	if body.Role != nil {
		// Lock to serialize with writes so the last-user-manager check can't race.
		unlock := h.db.LockUserManagement()
		defer unlock()
		newGrantsManage, err := h.db.RoleGrantsUserManagement(req.Context(), *body.Role)
		if err != nil {
			httperr.Write(w, req, err)
			return
		}
		selfChanging := caller != nil && caller.ID == id && *body.Role != caller.Role
		// Safety net: don't let a user strip their own ability to manage
		// users (the generalization of the old "don't demote yourself out
		// of admin" guard) — someone else must do it.
		if selfChanging && !newGrantsManage {
			http.Error(w, "cannot remove your own user-management access", http.StatusBadRequest)
			return
		}
		// System-wide safety net: never demote the last user who can manage
		// users, or the cluster loses all user administration.
		if !newGrantsManage {
			if managesNow, err := h.db.UserManagesUsers(req.Context(), id); err != nil {
				httperr.Write(w, req, err)
				return
			} else if managesNow {
				count, err := h.db.UserManagerCount(req.Context())
				if err != nil {
					httperr.Write(w, req, err)
					return
				}
				if count <= 1 {
					http.Error(w, "cannot demote the last user who can manage users", http.StatusBadRequest)
					return
				}
			}
		}
	}

	tx, err := h.db.DB.BeginTx(req.Context(), nil)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if body.DisplayName != nil {
		if _, err := tx.ExecContext(req.Context(),
			`UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?`,
			*body.DisplayName, db.NowTimestamp(), id); err != nil {
			httperr.Write(w, req, err)
			return
		}
	}
	if body.Email != nil {
		if _, err := tx.ExecContext(req.Context(),
			`UPDATE users SET email = ?, updated_at = ? WHERE id = ?`,
			*body.Email, db.NowTimestamp(), id); err != nil {
			httperr.Write(w, req, err)
			return
		}
	}
	if body.Role != nil {
		res, err := tx.ExecContext(req.Context(),
			`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`,
			*body.Role, db.NowTimestamp(), id)
		if err != nil {
			httperr.Write(w, req, err)
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			http.Error(w, "user not found", http.StatusNotFound)
			return
		}
		// Keep the cluster-wide ("*") role binding in sync with the primary
		// role; per-namespace bindings are left untouched.
		if err := h.db.SetClusterRoleBinding(req.Context(), tx, id, scope.DefaultCluster, *body.Role); err != nil {
			httperr.Write(w, req, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		httperr.Write(w, req, err)
		return
	}

	// Invalidate active sessions for the target user when their role
	// changes, so the new trust boundary takes effect immediately.
	// Without this a demoted admin keeps acting as admin until session
	// TTL expires.
	if body.Role != nil && h.sessions != nil {
		if err := h.sessions.DeleteForUser(req.Context(), id); err != nil {
			slog.Warn("invalidate sessions on role change", "err", err, "user", id)
		}
	}

	out, err := h.fetchByID(req.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "user not found", http.StatusNotFound)
			return
		}
		httperr.Write(w, req, err)
		return
	}
	writeJSON(w, out)
}

type resetPasswordReq struct {
	Password string `json:"password"`
}

func (h *userHandler) resetPassword(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(req, "id"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	var body resetPasswordReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if len(body.Password) < auth.MinPasswordLen {
		http.Error(w, "password too short", http.StatusBadRequest)
		return
	}
	hash, err := auth.HashPassword(req.Context(), body.Password)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	res, err := h.db.DB.ExecContext(req.Context(),
		`UPDATE users SET pw_hash = ?, updated_at = ? WHERE id = ?`,
		hash, db.NowTimestamp(), id)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		http.Error(w, "user not found", http.StatusNotFound)
		return
	}
	// Force the target user to re-authenticate under the new credential.
	// A leaked old password and an active session are otherwise equivalent
	// from the attacker's perspective; we want reset to actually evict.
	if h.sessions != nil {
		if err := h.sessions.DeleteForUser(req.Context(), id); err != nil {
			slog.Warn("invalidate sessions on password reset", "err", err, "user", id)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

type bindingDTO struct {
	RoleName  string `json:"roleName"`
	Namespace string `json:"namespace"`
	Cluster   string `json:"cluster"`
}

func (h *userHandler) listBindings(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(req, "id"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	rows, err := h.db.DB.QueryContext(req.Context(),
		`SELECT role_name, namespace, cluster FROM user_role_bindings WHERE user_id = ? ORDER BY cluster, namespace, role_name`, id)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []bindingDTO{}
	for rows.Next() {
		var b bindingDTO
		if err := rows.Scan(&b.RoleName, &b.Namespace, &b.Cluster); err != nil {
			httperr.Write(w, req, err)
			return
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		httperr.Write(w, req, err)
		return
	}
	writeJSON(w, out)
}

type addBindingReq struct {
	RoleName  string `json:"roleName"`
	Namespace string `json:"namespace"`
	Cluster   string `json:"cluster"`
}

func (h *userHandler) addBinding(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(req, "id"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	var body addBindingReq
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Default the cluster to the default cluster.
	if body.Cluster == "" {
		body.Cluster = scope.DefaultCluster
	}
	// The local cluster-wide role is still managed through the primary role.
	// An explicit remote-wide grant may carry only inventory/namespaced access.
	remoteWide := body.Namespace == "*" && body.Cluster != scope.DefaultCluster
	if !remoteWide && (body.Namespace == "*" || !scope.Allowed(body.Namespace)) {
		http.Error(w, "namespace not permitted", http.StatusBadRequest)
		return
	}
	// Validate the cluster.
	if body.Cluster == "*" {
		http.Error(w, "cluster not permitted", http.StatusBadRequest)
		return
	}
	known := false
	for _, id := range h.clusters.IDs() {
		if id == body.Cluster {
			known = true
			break
		}
	}
	if !known {
		http.Error(w, "cluster not permitted", http.StatusBadRequest)
		return
	}
	if remoteWide {
		// Serialize permission validation + insertion with role edits/deletion,
		// so a safe role cannot become a control-plane grant between them.
		unlock := h.db.LockUserManagement()
		defer unlock()
	}
	if ok, err := h.db.RoleExists(req.Context(), body.RoleName); err != nil {
		httperr.Write(w, req, err)
		return
	} else if !ok {
		http.Error(w, "invalid role", http.StatusBadRequest)
		return
	}
	if remoteWide {
		if allowed, err := remoteWideRoleAllowed(req.Context(), h.db, body.RoleName); err != nil {
			httperr.Write(w, req, err)
			return
		} else if !allowed {
			http.Error(w, "remote cluster-wide roles may grant only cluster:read and namespaced permissions", http.StatusBadRequest)
			return
		}
	}
	if ok, err := h.userExists(req.Context(), id); err != nil {
		httperr.Write(w, req, err)
		return
	} else if !ok {
		http.Error(w, "user not found", http.StatusNotFound)
		return
	}
	var dup int
	if err := h.db.DB.QueryRowContext(req.Context(),
		`SELECT COUNT(*) FROM user_role_bindings WHERE user_id = ? AND role_name = ? AND cluster = ? AND namespace = ?`,
		id, body.RoleName, body.Cluster, body.Namespace).Scan(&dup); err != nil {
		httperr.Write(w, req, err)
		return
	}
	if dup > 0 {
		http.Error(w, "binding already exists", http.StatusConflict)
		return
	}
	if _, err := h.db.DB.ExecContext(req.Context(),
		`INSERT INTO user_role_bindings(user_id, role_name, cluster, namespace) VALUES (?, ?, ?, ?)`,
		id, body.RoleName, body.Cluster, body.Namespace); err != nil {
		httperr.Write(w, req, err)
		return
	}
	h.invalidateSessions(req, id, "role binding added")
	writeJSONCreated(w, bindingDTO(body))
}

func (h *userHandler) deleteBinding(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(req, "id"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	role := chi.URLParam(req, "role")
	namespace := chi.URLParam(req, "namespace")
	cluster := req.URL.Query().Get("cluster")
	if cluster == "" {
		cluster = scope.DefaultCluster
	}
	if namespace == "*" && cluster == scope.DefaultCluster {
		http.Error(w, "the cluster-wide role is managed via the primary role", http.StatusBadRequest)
		return
	}
	if cluster == "*" {
		http.Error(w, "cluster not permitted", http.StatusBadRequest)
		return
	}
	if namespace == "*" {
		unlock := h.db.LockUserManagement()
		defer unlock()
		// Legacy externally provisioned global grants are not supplemental
		// remote readers; retain their previous removal protection.
		if allowed, err := remoteWideRoleAllowed(req.Context(), h.db, role); err != nil {
			httperr.Write(w, req, err)
			return
		} else if !allowed {
			http.Error(w, "remote control-plane bindings cannot be removed through supplemental grants", http.StatusBadRequest)
			return
		}
	}
	res, err := h.db.DB.ExecContext(req.Context(),
		`DELETE FROM user_role_bindings WHERE user_id = ? AND role_name = ? AND cluster = ? AND namespace = ?`,
		id, role, cluster, namespace)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.Error(w, "binding not found", http.StatusNotFound)
		return
	}
	h.invalidateSessions(req, id, "role binding removed")
	w.WriteHeader(http.StatusNoContent)
}

func (h *userHandler) userExists(ctx context.Context, id int64) (bool, error) {
	var x int
	err := h.db.DB.QueryRowContext(ctx, `SELECT 1 FROM users WHERE id = ?`, id).Scan(&x)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// invalidateSessions clears the target user's sessions so a binding change
// takes effect immediately. Permissions are resolved per request, so this
// is belt-and-suspenders — it forces a clean re-auth under the new grants.
func (h *userHandler) invalidateSessions(req *http.Request, id int64, reason string) {
	if h.sessions == nil {
		return
	}
	if err := h.sessions.DeleteForUser(req.Context(), id); err != nil {
		slog.Warn("invalidate sessions", "err", err, "user", id, "reason", reason)
	}
}

func (h *userHandler) fetchByID(ctx context.Context, id int64) (userDTO, error) {
	var u userDTO
	err := h.db.DB.QueryRowContext(ctx, `
		SELECT u.id, u.username, u.display_name, u.email, u.role, u.created_at,
		       CASE
		         WHEN EXISTS (SELECT 1 FROM oidc_links l WHERE l.user_id = u.id) THEN 'oidc'
		         WHEN u.pw_hash IS NOT NULL AND u.pw_hash <> ''               THEN 'local'
		         ELSE 'pending'
		       END
		FROM users u WHERE u.id = ?`, id,
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.Role, &u.CreatedAt, &u.Provider)
	if err == nil {
		u.CreatedAt = db.NormalizeTimestamp(u.CreatedAt)
	}
	return u, err
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
