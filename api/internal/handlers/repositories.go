package handlers

import (
	"cmp"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/db"
	"github.com/GameplanePanel/gameplane/api/internal/httperr"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
	"github.com/GameplanePanel/gameplane/api/internal/messages"
	"github.com/GameplanePanel/gameplane/api/internal/rbac"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
	"github.com/GameplanePanel/gameplane/api/internal/ws"
)

var repoURLRE = regexp.MustCompile(`^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

const maxRepositoryNameLen = 52

type repositoryOwner struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type repositoryStorage struct {
	Size string `json:"size"`
	Used *int64 `json:"used"`
}

type repositoryDTO struct {
	Name          string            `json:"name"`
	Namespace     string            `json:"namespace"`
	UID           string            `json:"uid"`
	URL           string            `json:"url"`
	Branch        string            `json:"branch"`
	Network       string            `json:"network"`
	Owner         repositoryOwner   `json:"owner"`
	Collaborators int               `json:"collaborators"`
	Phase         string            `json:"phase"`
	CloneProgress *int              `json:"cloneProgress"`
	Error         *string           `json:"error"`
	Head          *string           `json:"head"`
	Ahead         int               `json:"ahead"`
	Behind        int               `json:"behind"`
	Changes       int               `json:"changes"`
	LastFetch     *string           `json:"lastFetch"`
	Storage       repositoryStorage `json:"storage"`
}

type repositoryCollaborator struct {
	UserID   int64  `json:"userId"`
	Username string `json:"username"`
	Read     bool   `json:"read"`
	Edit     bool   `json:"edit"`
	Push     bool   `json:"push"`
}

type repositoryHandler struct {
	reg    *kube.Registry
	store  *db.Store
	agent  *ws.RepoAgent
	tokens GitHubTokens
}

// MountRepositories wires the repository CRUD, access, collaborator,
// network and re-clone routes (spec 029). Home cluster only.
func MountRepositories(r chi.Router, reg *kube.Registry, store *db.Store, agent *ws.RepoAgent, tokens GitHubTokens) {
	h := &repositoryHandler{reg: reg, store: store, agent: agent, tokens: tokens}
	r = r.With(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if !rejectRemoteCluster(w, req) {
				next.ServeHTTP(w, req)
			}
		})
	})
	r.Get("/repositories", h.list)
	r.Post("/repositories", h.create)
	r.Get("/repositories/{name}", h.get)
	r.Delete("/repositories/{name}", h.del)
	r.Get("/repositories/{name}/access", h.access)
	r.Put("/repositories/{name}:network", h.setNetwork)
	r.Post("/repositories/{name}:reclone", h.reclone)
	r.Get("/repositories/{name}/collaborators", h.collaborators)
	r.Post("/repositories/{name}/collaborators", h.putCollaborator)
	r.Put("/repositories/{name}/collaborators/{userId}", h.putCollaborator)
	r.Delete("/repositories/{name}/collaborators/{userId}", h.deleteCollaborator)
	agent.Mount(r)
}

func (h *repositoryHandler) repos(ns string) dynamic.ResourceInterface {
	return h.reg.Default().Dynamic.Resource(kube.GVRRepository).Namespace(ns)
}

func (h *repositoryHandler) list(w http.ResponseWriter, req *http.Request) {
	u := auth.UserFromContext(req.Context())
	namespaces := slices.Clone(scope.AllowedNamespaces)
	slices.Sort(namespaces)
	var items []unstructured.Unstructured
	for _, ns := range slices.Compact(namespaces) {
		list, err := h.repos(ns).List(req.Context(), metav1.ListOptions{})
		if apierrors.IsNotFound(err) || apierrors.IsForbidden(err) {
			continue
		}
		if err != nil {
			httperr.Write(w, req, err)
			return
		}
		items = append(items, list.Items...)
	}
	out := make([]repositoryDTO, 0, len(items))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := range items {
		obj := &items[i]
		if !slices.Contains(rbac.RepositoryPermissions(obj, u, scope.DefaultCluster, obj.GetNamespace()), rbac.RepoRead) {
			continue
		}
		wg.Go(func() {
			dto := h.dto(req, obj)
			mu.Lock()
			out = append(out, dto)
			mu.Unlock()
		})
	}
	wg.Wait()
	slices.SortFunc(out, func(a, b repositoryDTO) int { return strings.Compare(a.Namespace+"/"+a.Name, b.Namespace+"/"+b.Name) })
	writeJSON(w, out)
}

func (h *repositoryHandler) create(w http.ResponseWriter, req *http.Request) {
	ns, ok := resolveNS(w, req)
	if !ok {
		return
	}
	var body struct {
		URL         string `json:"url"`
		Branch      string `json:"branch"`
		Name        string `json:"name"`
		Network     string `json:"network"`
		StorageSize string `json:"storageSize"`
	}
	if err := json.NewDecoder(io.LimitReader(req.Body, 1<<16)).Decode(&body); err != nil {
		httperr.WriteMessage(w, req, messages.New("server.common.invalid_json", nil))
		return
	}
	body.URL = strings.TrimSuffix(strings.TrimSpace(body.URL), "/")
	size, err := resource.ParseQuantity(cmp.Or(body.StorageSize, "2Gi"))
	switch {
	case !repoURLRE.MatchString(body.URL):
		httperr.WriteMessage(w, req, messages.New("server.repositories.remote_not_allowed", nil))
		return
	case len(body.Name) > maxRepositoryNameLen || !dnsLabelRE.MatchString(body.Name):
		httperr.WriteMessage(w, req, messages.New("server.repositories.invalid_name", nil))
		return
	case body.Branch != "" && (len(body.Branch) > 255 || strings.ContainsAny(body.Branch, " ~^:?*[\\") || strings.HasPrefix(body.Branch, "-")):
		httperr.WriteMessage(w, req, messages.New("server.repositories.invalid_branch", nil))
		return
	case err != nil || size.Sign() <= 0:
		httperr.WriteMessage(w, req, messages.New("server.repositories.invalid_storage", nil))
		return
	}
	u := auth.UserFromContext(req.Context())
	if _, ok := h.tokens.Credentials(req.Context(), u.ID); !ok {
		httperr.WriteMessage(w, req, messages.New("server.repositories.github_token_required", nil))
		return
	}
	if !h.networkExists(w, req, body.Network) {
		return
	}
	if _, err := h.reg.Default().GetServer(req.Context(), ns, body.Name); err == nil {
		httperr.WriteMessage(w, req, messages.New("server.repositories.name_taken", nil))
		return
	} else if !apierrors.IsNotFound(err) {
		httperr.Write(w, req, err)
		return
	}
	annotations := map[string]any{ownerIDAnnotation: strconv.FormatInt(u.ID, 10), ownerAnnotation: u.Username}
	if body.Network != "" {
		annotations[networkAnnotation] = body.Network
	}
	spec := map[string]any{"url": body.URL, "storage": map[string]any{"size": size.String()}}
	if body.Branch != "" {
		spec["branch"] = body.Branch
	}
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "gameplane.local/v1alpha1", "kind": "Repository",
		"metadata": map[string]any{"name": body.Name, "namespace": ns, "annotations": annotations},
		"spec":     spec,
	}}
	created, err := h.repos(ns).Create(req.Context(), obj, metav1.CreateOptions{})
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	writeJSONCreated(w, h.dto(req, created))
}

func (h *repositoryHandler) bound(w http.ResponseWriter, req *http.Request) (*unstructured.Unstructured, rbac.RepositoryGrant, bool) {
	grant, ok := rbac.RepositoryGrantFrom(req.Context())
	if !ok {
		httperr.WriteMessage(w, req, messages.New(httperr.IDNotFound, nil))
		return nil, grant, false
	}
	obj, err := h.repos(grant.Identity.Namespace).Get(req.Context(), grant.Identity.Name, metav1.GetOptions{})
	if err == nil && string(obj.GetUID()) != grant.Identity.UID {
		err = apierrors.NewNotFound(kube.GVRRepository.GroupResource(), grant.Identity.Name)
	}
	if err != nil {
		httperr.Write(w, req, err)
		return nil, grant, false
	}
	return obj, grant, true
}

func (h *repositoryHandler) get(w http.ResponseWriter, req *http.Request) {
	if obj, _, ok := h.bound(w, req); ok {
		writeJSON(w, h.dto(req, obj))
	}
}

func (h *repositoryHandler) del(w http.ResponseWriter, req *http.Request) {
	obj, grant, ok := h.bound(w, req)
	if !ok || !requireRepo(w, req, grant, rbac.RepoManage) {
		return
	}
	uid := obj.GetUID()
	if err := h.repos(obj.GetNamespace()).Delete(req.Context(), obj.GetName(), metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &uid}}); err != nil {
		httperr.Write(w, req, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *repositoryHandler) access(w http.ResponseWriter, req *http.Request) {
	obj, grant, ok := h.bound(w, req)
	if !ok {
		return
	}
	u := auth.UserFromContext(req.Context())
	writeJSON(w, map[string]any{
		"isOwner":        obj.GetAnnotations()[ownerIDAnnotation] == strconv.FormatInt(u.ID, 10),
		"isCollaborator": slices.Contains(collaboratorIDs(obj), u.ID),
		"permissions":    grant.Permissions,
	})
}

func (h *repositoryHandler) setNetwork(w http.ResponseWriter, req *http.Request) {
	obj, grant, ok := h.bound(w, req)
	if !ok || !requireRepo(w, req, grant, rbac.RepoManage) {
		return
	}
	var body setNetworkReq
	if err := json.NewDecoder(io.LimitReader(req.Body, 1<<16)).Decode(&body); err != nil {
		httperr.WriteMessage(w, req, messages.New("server.common.invalid_json", nil))
		return
	}
	if !h.networkExists(w, req, body.Network) {
		return
	}
	var value any
	if body.Network != "" {
		value = body.Network
	}
	h.patchAnnotations(w, req, obj, map[string]any{networkAnnotation: value})
}

func (h *repositoryHandler) reclone(w http.ResponseWriter, req *http.Request) {
	obj, grant, ok := h.bound(w, req)
	if !ok || !requireRepo(w, req, grant, rbac.RepoManage) {
		return
	}
	creds, ok := h.tokens.Credentials(req.Context(), auth.UserFromContext(req.Context()).ID)
	if !ok {
		httperr.WriteMessage(w, req, messages.New("server.repositories.github_token_required", nil))
		return
	}
	url, _, _ := unstructured.NestedString(obj.Object, "spec", "url")
	branch, _, _ := unstructured.NestedString(obj.Object, "spec", "branch")
	if err := h.agent.Clone(req.Context(), obj.GetNamespace(), obj.GetName(), string(obj.GetUID()), url, branch, true, creds.Token); err != nil {
		httperr.WriteMessage(w, req, messages.New("server.repositories.agent_unavailable", nil))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(h.dto(req, obj))
}

func (h *repositoryHandler) collaborators(w http.ResponseWriter, req *http.Request) {
	obj, _, ok := h.bound(w, req)
	if !ok {
		return
	}
	names := strings.Split(obj.GetAnnotations()[collaboratorNamesAnnotation], ",")
	grants := rbac.RepoCollaboratorGrants(obj)
	out := []repositoryCollaborator{}
	for i, id := range collaboratorIDs(obj) {
		c := repositoryCollaborator{UserID: id, Read: true, Edit: slices.Contains(grants[id], rbac.RepoWrite), Push: slices.Contains(grants[id], rbac.RepoPush)}
		if i < len(names) {
			c.Username = names[i]
		}
		out = append(out, c)
	}
	writeJSON(w, out)
}

func (h *repositoryHandler) putCollaborator(w http.ResponseWriter, req *http.Request) {
	obj, grant, ok := h.bound(w, req)
	if !ok || !requireRepo(w, req, grant, rbac.RepoManage) {
		return
	}
	var body struct {
		Username string `json:"username"`
		Edit     bool   `json:"edit"`
		Push     bool   `json:"push"`
	}
	if json.NewDecoder(io.LimitReader(req.Body, 1<<16)).Decode(&body) != nil {
		httperr.WriteMessage(w, req, messages.New("server.ownership.invalid_request", nil))
		return
	}
	query, key := `SELECT id, username FROM users WHERE username = ?`, any(strings.TrimSpace(body.Username))
	if raw := chi.URLParam(req, "userId"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			httperr.WriteMessage(w, req, messages.New("server.ownership.invalid_request", nil))
			return
		}
		query, key = `SELECT id, username FROM users WHERE id = ?`, id
	}
	var userID int64
	var username string
	err := h.store.DB.QueryRowContext(req.Context(), query, key).Scan(&userID, &username)
	if errors.Is(err, sql.ErrNoRows) {
		httperr.WriteMessage(w, req, messages.New("server.common.user_not_found", nil))
		return
	}
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	if obj.GetAnnotations()[ownerIDAnnotation] == strconv.FormatInt(userID, 10) {
		httperr.WriteMessage(w, req, messages.New("server.repositories.owner_not_collaborator", nil))
		return
	}
	var perms []string
	if body.Edit {
		perms = append(perms, rbac.RepoWrite)
	}
	if body.Push {
		perms = append(perms, rbac.RepoPush)
	}
	h.writeCollaborators(w, req, obj, func(names map[int64]string, grants map[int64][]string) {
		names[userID], grants[userID] = username, perms
	})
}

func (h *repositoryHandler) deleteCollaborator(w http.ResponseWriter, req *http.Request) {
	obj, grant, ok := h.bound(w, req)
	if !ok || !requireRepo(w, req, grant, rbac.RepoManage) {
		return
	}
	userID, err := strconv.ParseInt(chi.URLParam(req, "userId"), 10, 64)
	if err != nil {
		httperr.WriteMessage(w, req, messages.New("server.ownership.invalid_request", nil))
		return
	}
	h.writeCollaborators(w, req, obj, func(names map[int64]string, grants map[int64][]string) {
		delete(names, userID)
		delete(grants, userID)
	})
}

func (h *repositoryHandler) writeCollaborators(w http.ResponseWriter, req *http.Request, obj *unstructured.Unstructured, change func(map[int64]string, map[int64][]string)) {
	names := map[int64]string{}
	nameList := strings.Split(obj.GetAnnotations()[collaboratorNamesAnnotation], ",")
	for i, id := range collaboratorIDs(obj) {
		if i < len(nameList) {
			names[id] = nameList[i]
		}
	}
	grants := rbac.RepoCollaboratorGrants(obj)
	change(names, grants)
	ids, nameValue := collaboratorAnnotations(names, obj.GetAnnotations()[ownerIDAnnotation])
	stored := map[string][]string{}
	for id := range names {
		if len(grants[id]) > 0 {
			stored[strconv.FormatInt(id, 10)] = grants[id]
		}
	}
	grantValue, err := json.Marshal(stored)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	h.patchAnnotations(w, req, obj, map[string]any{
		collaboratorsAnnotation: ids, collaboratorNamesAnnotation: nameValue,
		rbac.RepoCollaboratorPermissionsAnnotation: string(grantValue),
	})
}

func (h *repositoryHandler) patchAnnotations(w http.ResponseWriter, req *http.Request, obj *unstructured.Unstructured, annotations map[string]any) {
	patch, err := json.Marshal(map[string]any{"metadata": map[string]any{
		"uid": obj.GetUID(), "resourceVersion": obj.GetResourceVersion(), "annotations": annotations,
	}})
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	if _, err := h.repos(obj.GetNamespace()).Patch(req.Context(), obj.GetName(), types.MergePatchType, patch, metav1.PatchOptions{}); err != nil {
		httperr.Write(w, req, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *repositoryHandler) networkExists(w http.ResponseWriter, req *http.Request, network string) bool {
	if network == "" {
		return true
	}
	var exists int
	err := h.store.DB.QueryRowContext(req.Context(), `SELECT 1 FROM networks WHERE name = ?`, network).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		httperr.WriteMessage(w, req, messages.New("server.repositories.network_not_found", nil))
		return false
	}
	if err != nil {
		httperr.Write(w, req, err)
		return false
	}
	return true
}

func requireRepo(w http.ResponseWriter, req *http.Request, grant rbac.RepositoryGrant, perm string) bool {
	if !grant.Has(perm) {
		httperr.WriteMessage(w, req, messages.New(httperr.IDForbidden, nil))
		return false
	}
	return true
}

func collaboratorIDs(obj *unstructured.Unstructured) []int64 {
	var ids []int64
	for _, raw := range strings.Split(obj.GetAnnotations()[collaboratorsAnnotation], ",") {
		if id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64); err == nil {
			ids = append(ids, id)
		}
	}
	return ids
}

// dto merges the CR with the agent's live clone state and status. The
// owner's first view of a repository whose agent is up but has no working
// copy yet starts the clone with the owner's own token.
func (h *repositoryHandler) dto(req *http.Request, obj *unstructured.Unstructured) repositoryDTO {
	ann := obj.GetAnnotations()
	url, _, _ := unstructured.NestedString(obj.Object, "spec", "url")
	branch, _, _ := unstructured.NestedString(obj.Object, "spec", "branch")
	size, _, _ := unstructured.NestedString(obj.Object, "spec", "storage", "size")
	phase, _, _ := unstructured.NestedString(obj.Object, "status", "phase")
	dto := repositoryDTO{
		Name: obj.GetName(), Namespace: obj.GetNamespace(), UID: string(obj.GetUID()), URL: url, Branch: branch,
		Network: ann[networkAnnotation], Owner: repositoryOwner{ID: ann[ownerIDAnnotation], Name: ann[ownerAnnotation]},
		Collaborators: len(collaboratorIDs(obj)), Phase: cmp.Or(phase, "Pending"),
		Storage: repositoryStorage{Size: cmp.Or(size, "2Gi")},
	}
	if !repositoryAgentReady(obj) {
		return dto
	}
	clone, status, err := h.agent.Live(req.Context(), obj.GetNamespace(), obj.GetName(), dto.UID)
	if err != nil {
		return dto
	}
	u := auth.UserFromContext(req.Context())
	if status == nil && clone.State == "idle" && ann[ownerIDAnnotation] == strconv.FormatInt(u.ID, 10) {
		if creds, ok := h.tokens.Credentials(req.Context(), u.ID); ok &&
			h.agent.Clone(req.Context(), obj.GetNamespace(), obj.GetName(), dto.UID, url, branch, false, creds.Token) == nil {
			clone.State = "running"
		}
	}
	switch {
	case clone.State == "running":
		dto.Phase, dto.CloneProgress = "Cloning", &clone.Progress
	case clone.State == "failed":
		dto.Phase = "Failed"
		if clone.Error != nil {
			dto.Error = &clone.Error.Message
		}
	case status != nil:
		dto.Phase, dto.Head, dto.Ahead, dto.Behind, dto.Changes = "Ready", status.Head, status.Ahead, status.Behind, len(status.Changes)
		dto.Branch = cmp.Or(status.Branch, branch)
	}
	return dto
}

func repositoryAgentReady(obj *unstructured.Unstructured) bool {
	conditions, _, _ := unstructured.NestedSlice(obj.Object, "status", "conditions")
	for _, raw := range conditions {
		if c, ok := raw.(map[string]any); ok && c["type"] == "AgentReady" {
			return c["status"] == "True"
		}
	}
	return false
}
