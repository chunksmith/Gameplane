package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/GameplanePanel/gameplane/api/internal/db"
	"github.com/GameplanePanel/gameplane/api/internal/httperr"
)

var networkPermissions = []string{"servers:console", "servers:write"}

type networkMemberDTO struct {
	ID          int64    `json:"id"`
	Username    string   `json:"username"`
	Permissions []string `json:"permissions"`
}

type networkDTO struct {
	Name    string             `json:"name"`
	Members []networkMemberDTO `json:"members"`
}

type networkHandler struct {
	db *db.Store
}

func mountNetworks(r chi.Router, store *db.Store) {
	h := &networkHandler{db: store}
	r.Route("/networks", func(r chi.Router) {
		r.Get("/", h.list)
		r.Post("/", h.create)
		r.Delete("/{name}", h.del)
		r.Put("/{name}/members/{id}", h.addMember)
		r.Delete("/{name}/members/{id}", h.removeMember)
	})
}

func (h *networkHandler) list(w http.ResponseWriter, req *http.Request) {
	out := []networkDTO{}
	index := map[string]int{}
	rows, err := h.db.DB.QueryContext(req.Context(), `SELECT name FROM networks ORDER BY name`)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			httperr.Write(w, req, err)
			return
		}
		index[name] = len(out)
		out = append(out, networkDTO{Name: name, Members: []networkMemberDTO{}})
	}
	if err := rows.Err(); err != nil {
		httperr.Write(w, req, err)
		return
	}
	members, err := h.db.DB.QueryContext(req.Context(), `
		SELECT m.network_name, u.id, u.username, m.permissions
		FROM network_members m JOIN users u ON u.id = m.user_id
		ORDER BY u.username`)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	defer func() { _ = members.Close() }()
	for members.Next() {
		var network, permissions string
		var member networkMemberDTO
		if err := members.Scan(&network, &member.ID, &member.Username, &permissions); err != nil {
			httperr.Write(w, req, err)
			return
		}
		member.Permissions = strings.FieldsFunc(permissions, func(r rune) bool { return r == ',' })
		if i, ok := index[network]; ok {
			out[i].Members = append(out[i].Members, member)
		}
	}
	if err := members.Err(); err != nil {
		httperr.Write(w, req, err)
		return
	}
	writeJSON(w, out)
}

func (h *networkHandler) create(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !identifierRE.MatchString(body.Name) {
		http.Error(w, "invalid network name", http.StatusBadRequest)
		return
	}
	if found, err := h.exists(req, body.Name); err != nil {
		httperr.Write(w, req, err)
		return
	} else if found {
		http.Error(w, "network already exists", http.StatusConflict)
		return
	}
	if _, err := h.db.DB.ExecContext(req.Context(), `INSERT INTO networks(name) VALUES (?)`, body.Name); err != nil {
		httperr.Write(w, req, err)
		return
	}
	writeJSONCreated(w, networkDTO{Name: body.Name, Members: []networkMemberDTO{}})
}

func (h *networkHandler) del(w http.ResponseWriter, req *http.Request) {
	name := chi.URLParam(req, "name")
	tx, err := h.db.DB.BeginTx(req.Context(), nil)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(req.Context(), `DELETE FROM network_members WHERE network_name = ?`, name); err != nil {
		httperr.Write(w, req, err)
		return
	}
	res, err := tx.ExecContext(req.Context(), `DELETE FROM networks WHERE name = ?`, name)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.Error(w, "network not found", http.StatusNotFound)
		return
	}
	if err := tx.Commit(); err != nil {
		httperr.Write(w, req, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *networkHandler) addMember(w http.ResponseWriter, req *http.Request) {
	name, id, ok := h.memberTarget(w, req)
	if !ok {
		return
	}
	var body struct {
		Permissions []string `json:"permissions"`
	}
	if err := json.NewDecoder(io.LimitReader(req.Body, 1<<16)).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	for _, permission := range body.Permissions {
		if !slices.Contains(networkPermissions, permission) {
			http.Error(w, "invalid permission", http.StatusBadRequest)
			return
		}
	}
	slices.Sort(body.Permissions)
	if _, err := h.db.DB.ExecContext(req.Context(),
		`INSERT INTO network_members(network_name, user_id, permissions) VALUES (?, ?, ?)
		ON CONFLICT (network_name, user_id) DO UPDATE SET permissions = excluded.permissions`,
		name, id, strings.Join(slices.Compact(body.Permissions), ",")); err != nil {
		httperr.Write(w, req, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *networkHandler) removeMember(w http.ResponseWriter, req *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(req, "id"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	res, err := h.db.DB.ExecContext(req.Context(),
		`DELETE FROM network_members WHERE network_name = ? AND user_id = ?`, chi.URLParam(req, "name"), id)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.Error(w, "member not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *networkHandler) memberTarget(w http.ResponseWriter, req *http.Request) (string, int64, bool) {
	name := chi.URLParam(req, "name")
	id, err := strconv.ParseInt(chi.URLParam(req, "id"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return "", 0, false
	}
	if found, err := h.exists(req, name); err != nil {
		httperr.Write(w, req, err)
		return "", 0, false
	} else if !found {
		http.Error(w, "network not found", http.StatusNotFound)
		return "", 0, false
	}
	var user int
	err = h.db.DB.QueryRowContext(req.Context(), `SELECT 1 FROM users WHERE id = ?`, id).Scan(&user)
	if errors.Is(err, sql.ErrNoRows) {
		http.Error(w, "user not found", http.StatusNotFound)
		return "", 0, false
	}
	if err != nil {
		httperr.Write(w, req, err)
		return "", 0, false
	}
	return name, id, true
}

func (h *networkHandler) exists(req *http.Request, name string) (bool, error) {
	var found int
	err := h.db.DB.QueryRowContext(req.Context(), `SELECT 1 FROM networks WHERE name = ?`, name).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
