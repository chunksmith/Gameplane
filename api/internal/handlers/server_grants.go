package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strconv"

	"github.com/go-chi/chi/v5"
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/GameplanePanel/gameplane/api/internal/db"
	"github.com/GameplanePanel/gameplane/api/internal/httperr"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
)

var serverGrantPermissions = []string{"servers:console", "servers:write"}

type serverGrantDTO struct {
	UserID      int64    `json:"userId"`
	Cluster     string   `json:"cluster"`
	Namespace   string   `json:"namespace"`
	Server      string   `json:"server"`
	Permissions []string `json:"permissions"`
}

type serverGrantHandler struct {
	reg   *kube.Registry
	store *db.Store
}

func MountServerGrants(r chi.Router, reg *kube.Registry, store *db.Store) {
	h := &serverGrantHandler{reg: reg, store: store}
	r.Route("/server-grants", func(r chi.Router) {
		r.Get("/", h.list)
		r.Put("/", h.put)
		r.Delete("/", h.del)
	})
}

func (h *serverGrantHandler) list(w http.ResponseWriter, req *http.Request) {
	userID, err := strconv.ParseInt(req.URL.Query().Get("userId"), 10, 64)
	if err != nil {
		http.Error(w, "bad user id", http.StatusBadRequest)
		return
	}
	members, err := h.store.ListServerMembers(req.Context(), userID)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	out := make([]serverGrantDTO, 0, len(members))
	for _, m := range members {
		out = append(out, serverGrantDTO{UserID: m.UserID, Cluster: m.Cluster, Namespace: m.Namespace, Server: m.Server, Permissions: m.Permissions})
	}
	writeJSON(w, out)
}

func (h *serverGrantHandler) put(w http.ResponseWriter, req *http.Request) {
	var body serverGrantDTO
	if err := json.NewDecoder(io.LimitReader(req.Body, 1<<16)).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if body.Cluster == "" || body.Namespace == "" || body.Server == "" {
		http.Error(w, "cluster, namespace and server are required", http.StatusBadRequest)
		return
	}
	for _, permission := range body.Permissions {
		if !slices.Contains(serverGrantPermissions, permission) {
			http.Error(w, "invalid permission", http.StatusBadRequest)
			return
		}
	}
	var user int
	err := h.store.DB.QueryRowContext(req.Context(), `SELECT 1 FROM users WHERE id = ?`, body.UserID).Scan(&user)
	if errors.Is(err, sql.ErrNoRows) {
		http.Error(w, "user not found", http.StatusNotFound)
		return
	}
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	k, ok := h.reg.Get(body.Cluster)
	if !ok {
		http.Error(w, "cluster not found", http.StatusNotFound)
		return
	}
	obj, err := k.GetServer(req.Context(), body.Namespace, body.Server)
	if apierrors.IsNotFound(err) {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	slices.Sort(body.Permissions)
	if err := h.store.UpsertServerMember(req.Context(), db.ServerMember{
		UserID:      body.UserID,
		Cluster:     body.Cluster,
		Namespace:   body.Namespace,
		Server:      body.Server,
		ServerUID:   string(obj.GetUID()),
		Permissions: slices.Compact(body.Permissions),
	}); err != nil {
		httperr.Write(w, req, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *serverGrantHandler) del(w http.ResponseWriter, req *http.Request) {
	query := req.URL.Query()
	userID, err := strconv.ParseInt(query.Get("userId"), 10, 64)
	if err != nil {
		http.Error(w, "bad user id", http.StatusBadRequest)
		return
	}
	deleted, err := h.store.DeleteServerMember(req.Context(), userID, query.Get("cluster"), query.Get("namespace"), query.Get("server"))
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	if !deleted {
		http.Error(w, "grant not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
