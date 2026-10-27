package rbac

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
)

// Repository permissions.
const (
	RepoRead   = "repositories:read"
	RepoWrite  = "repositories:write"
	RepoPush   = "repositories:push"
	RepoCreate = "repositories:create"
	RepoManage = "repositories:manage"
)

// RepoCollaboratorPermissionsAnnotation maps collaborator user IDs to the
// repository permissions beyond read that they hold, as a JSON object.
const RepoCollaboratorPermissionsAnnotation = "gameplane.local/collaborator-permissions"

var repoMemberPerms = []string{RepoRead, RepoWrite, RepoPush, RepoManage}

// RepositoryFetcher fetches a Repository for the owner, collaborator and
// network fallback. *kube.Registry satisfies it.
type RepositoryFetcher interface {
	GetRepository(ctx context.Context, cluster, ns, name string) (*unstructured.Unstructured, error)
}

// RepositoryGrant is the repository and the permissions the caller holds
// on it, bound by the middleware for the handlers and the agent proxy.
type RepositoryGrant struct {
	Identity    ServerIdentity
	Permissions []string
}

// Has reports whether the grant includes perm.
func (g RepositoryGrant) Has(perm string) bool {
	return slices.Contains(g.Permissions, perm)
}

type repositoryGrantKey struct{}

// RepositoryGrantFrom returns the grant the middleware bound to ctx.
func RepositoryGrantFrom(ctx context.Context) (RepositoryGrant, bool) {
	grant, ok := ctx.Value(repositoryGrantKey{}).(RepositoryGrant)
	return grant, ok
}

// RepositoryPermissions resolves what u may do on the repository obj: the
// namespace permissions, then owner (everything), collaborator (read plus
// the stored grants) and network membership (read plus the network's
// repository grants). repositories:manage stands for the owner-only
// operations.
func RepositoryPermissions(obj *unstructured.Unstructured, u *auth.User, cluster, ns string) []string {
	if u.Can(RepoManage, true, cluster, ns) || ownershipRole(obj, u.ID) == roleOwner {
		return slices.Clone(repoMemberPerms)
	}
	var perms []string
	add := func(granted ...string) {
		for _, perm := range granted {
			if strings.HasPrefix(perm, "repositories:") && perm != RepoManage && perm != RepoCreate && !slices.Contains(perms, perm) {
				perms = append(perms, perm)
			}
		}
	}
	for _, perm := range repoMemberPerms {
		if u.Can(perm, true, cluster, ns) {
			add(perm)
		}
	}
	if ownershipRole(obj, u.ID) == roleCollaborator {
		add(RepoRead)
		add(RepoCollaboratorGrants(obj)[u.ID]...)
	}
	if granted, member := u.Networks[obj.GetAnnotations()[networkAnnotation]]; member {
		add(RepoRead)
		add(granted...)
	}
	return perms
}

// RepoCollaboratorGrants parses the collaborator permissions annotation.
func RepoCollaboratorGrants(obj *unstructured.Unstructured) map[int64][]string {
	var raw map[string][]string
	_ = json.Unmarshal([]byte(obj.GetAnnotations()[RepoCollaboratorPermissionsAnnotation]), &raw)
	out := make(map[int64][]string, len(raw))
	for id, perms := range raw {
		if userID, err := strconv.ParseInt(id, 10, 64); err == nil {
			out[userID] = perms
		}
	}
	return out
}

func repositoryOwnerOnly(method, path, verb string, isExact bool) bool {
	return verb == "network" || verb == "reclone" || (method == http.MethodDelete && isExact) ||
		(method != http.MethodGet && strings.Contains(path, "/collaborators"))
}

func repositoryAccess(req *http.Request, fetch ServerFetcher, u *auth.User, perm, cluster, ns string) (*http.Request, bool) {
	if req.URL.Path == "/repositories" {
		return req, u.Can(perm, true, cluster, ns)
	}
	name, verb, isExact, ok := parseResourcePath(req.URL.Path, "repositories")
	repos, fetches := fetch.(RepositoryFetcher)
	if !ok || !fetches {
		return req, false
	}
	required := perm
	if repositoryOwnerOnly(req.Method, req.URL.Path, verb, isExact) {
		required = RepoManage
	}
	obj, err := repos.GetRepository(req.Context(), cluster, ns, name)
	if err != nil || obj == nil {
		return req, u.Can(required, true, cluster, ns)
	}
	grant := RepositoryGrant{
		Identity:    ServerIdentity{Cluster: cluster, Namespace: ns, Name: name, UID: string(obj.GetUID())},
		Permissions: RepositoryPermissions(obj, u, cluster, ns),
	}
	if !grant.Has(required) {
		return req, false
	}
	return req.WithContext(context.WithValue(req.Context(), repositoryGrantKey{}, grant)), true
}
