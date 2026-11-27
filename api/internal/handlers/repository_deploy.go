package handlers

import (
	"cmp"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/httperr"
	"github.com/GameplanePanel/gameplane/api/internal/messages"
	"github.com/GameplanePanel/gameplane/api/internal/rbac"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

const buildDeployParallel = 4

type buildTarget struct {
	Cluster   string `json:"cluster,omitempty"`
	Namespace string `json:"namespace,omitempty"`
	Server    string `json:"server"`
}

type buildDeployRequest struct {
	Artifact string        `json:"artifact"`
	Targets  []buildTarget `json:"targets"`
	Dir      string        `json:"dir,omitempty"`
	Filename string        `json:"filename,omitempty"`
	Remove   []string      `json:"remove,omitempty"`
	Restart  bool          `json:"restart,omitempty"`
}

type buildDeployPlan struct {
	dir      string
	filename string
	remove   []string
	restart  bool
	targets  []buildTarget
}

type buildDeployResult struct {
	Deployment buildDeployment `json:"deployment"`
}

func (h *buildHandler) deploy(w http.ResponseWriter, req *http.Request) {
	repo, _, ok := h.repository(w, req)
	if !ok {
		return
	}
	obj, ok := h.buildFor(w, req, repo)
	if !ok {
		return
	}
	var in buildDeployRequest
	if err := json.NewDecoder(io.LimitReader(req.Body, 1<<16)).Decode(&in); err != nil {
		httperr.WriteMessage(w, req, messages.New("server.common.invalid_json", nil))
		return
	}
	view, err := toBuildView(obj)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	if view.Phase != buildPhaseSucceeded {
		httperr.WriteMessage(w, req, messages.New(messages.ID(buildErrNotSucceeded), nil))
		return
	}
	artifact, found := artifactOf(view.Artifacts, in.Artifact)
	if !found {
		httperr.WriteMessage(w, req, messages.New(messages.ID(buildErrArtifactUnknown), nil))
		return
	}
	plan, code := planDeploy(in, artifact.Path, repo.GetNamespace())
	if code != "" {
		httperr.WriteMessage(w, req, messages.New(messages.ID(code), nil))
		return
	}
	authorize := rbac.Middleware(h.reg)
	for _, t := range plan.targets {
		for _, target := range plan.probes(t) {
			if !permits(authorize, req, target) {
				httperr.WriteMessage(w, req, messages.New(messages.ID(buildErrTargetForbidden), nil))
				return
			}
		}
	}
	creds := aiCredentials(req)
	status, data := routerCall(req.Context(), h.router, creds, http.MethodGet, "/repositories/"+repo.GetName()+"/files/download?"+url.Values{"path": {"/" + artifact.Path}, "namespace": {repo.GetNamespace()}}.Encode(), nil, "")
	switch {
	case status == http.StatusNotFound, status == http.StatusOK && sha256Hex(data) != artifact.SHA256:
		httperr.WriteMessage(w, req, messages.New(messages.ID(buildErrArtifactChanged), nil))
		return
	case status != http.StatusOK:
		httperr.WriteMessage(w, req, messages.New("server.repositories.agent_unavailable", nil))
		return
	}
	results := make([]buildDeploymentTarget, len(plan.targets))
	slots := make(chan struct{}, buildDeployParallel)
	var wg sync.WaitGroup
	for i, t := range plan.targets {
		wg.Go(func() {
			slots <- struct{}{}
			defer func() { <-slots }()
			results[i] = h.deployTarget(req.Context(), creds, t, plan, data)
		})
	}
	wg.Wait()
	u := auth.UserFromContext(req.Context())
	via := buildOrigin(req.Context())
	var approvedBy *string
	if userApproved(req.Context()) {
		approvedBy = &u.Username
	}
	deployment := buildDeployment{
		ID: randomID(), Time: time.Now().UTC().Format(time.RFC3339), Artifact: artifact.Path,
		Dir: plan.dir, Filename: plan.filename, Removed: plan.remove, Restart: plan.restart,
		Actor: buildActor{ID: strconv.FormatInt(u.ID, 10), Name: cmp.Or(u.DisplayName, u.Username)}, Via: via, ApprovedBy: approvedBy,
		Targets: results,
	}
	if err := h.appendDeployment(req.Context(), repo.GetNamespace(), obj.GetName(), deployment); err != nil {
		httperr.Write(w, req, err)
		return
	}
	written := 0
	for _, result := range results {
		if result.OK {
			written++
		}
	}
	if !h.record(w, req, obj.GetName(), fmt.Sprintf("repository.build.deploy artifact=%s written=%d/%d", artifact.Path, written, len(results)), http.StatusOK) {
		return
	}
	writeJSON(w, buildDeployResult{Deployment: deployment})
}

func (h *buildHandler) deployTarget(ctx context.Context, creds aiCreds, t buildTarget, plan buildDeployPlan, data []byte) buildDeploymentTarget {
	result := buildDeploymentTarget{Cluster: cmp.Or(t.Cluster, scope.DefaultCluster), Namespace: t.Namespace, Server: t.Server, OK: true}
	status, body := routerCall(ctx, h.router, creds, http.MethodPost, serverTarget(t, "/files/write", url.Values{"path": {plan.filePath(plan.filename)}}), data, "application/octet-stream")
	if status >= http.StatusBadRequest {
		return result.failed(status, body)
	}
	for _, old := range plan.remove {
		status, body = routerCall(ctx, h.router, creds, http.MethodDelete, serverTarget(t, "/files/delete", url.Values{"path": {plan.filePath(old)}}), nil, "")
		if status >= http.StatusBadRequest && status != http.StatusNotFound {
			return result.failed(status, body)
		}
	}
	if plan.restart {
		status, body = routerCall(ctx, h.router, creds, http.MethodPost, serverTarget(t, ":restart", url.Values{}), nil, "")
		if status >= http.StatusBadRequest {
			return result.failed(status, body)
		}
	}
	return result
}

func (r buildDeploymentTarget) failed(status int, body []byte) buildDeploymentTarget {
	msg := fmt.Sprintf("HTTP %d: %s", status, aiClip(strings.TrimSpace(string(body)), 200))
	r.OK, r.Error = false, &msg
	return r
}

func (h *buildHandler) appendDeployment(ctx context.Context, ns, name string, deployment buildDeployment) error {
	for attempt := 0; ; attempt++ {
		obj, err := h.builds(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return err
		}
		var list []buildDeployment
		_ = json.Unmarshal([]byte(obj.GetAnnotations()[buildAnnotationDeployments]), &list)
		list = append(list, deployment)
		if len(list) > buildDeploymentsMax {
			list = list[len(list)-buildDeploymentsMax:]
		}
		raw, err := json.Marshal(list)
		if err != nil {
			return fmt.Errorf("encode deployments: %w", err)
		}
		patch, err := json.Marshal(map[string]any{"metadata": map[string]any{
			"resourceVersion": obj.GetResourceVersion(),
			"annotations":     map[string]any{buildAnnotationDeployments: string(raw)},
		}})
		if err != nil {
			return fmt.Errorf("encode deployments patch: %w", err)
		}
		_, err = h.builds(ns).Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{})
		if !apierrors.IsConflict(err) || attempt == 2 {
			return err
		}
	}
}

func (p buildDeployPlan) filePath(name string) string {
	return "/" + p.dir + "/" + name
}

func (p buildDeployPlan) probes(t buildTarget) []string {
	out := []string{serverTarget(t, "/files/write", url.Values{"path": {p.filePath(p.filename)}})}
	if p.restart {
		out = append(out, serverTarget(t, ":restart", url.Values{}))
	}
	return out
}

func serverTarget(t buildTarget, suffix string, query url.Values) string {
	query.Set("namespace", t.Namespace)
	if t.Cluster != "" {
		query.Set("cluster", t.Cluster)
	}
	return "/servers/" + t.Server + suffix + "?" + query.Encode()
}

func planDeploy(in buildDeployRequest, artifact, namespace string) (buildDeployPlan, string) {
	plan := buildDeployPlan{
		dir: cmp.Or(in.Dir, "plugins"), filename: cmp.Or(in.Filename, path.Base(artifact)), remove: []string{}, restart: in.Restart,
	}
	if len(in.Targets) == 0 || len(in.Targets) > 50 {
		return plan, buildErrBadTarget
	}
	seen := map[string]bool{}
	for _, t := range in.Targets {
		t.Namespace = cmp.Or(t.Namespace, namespace)
		key := t.Cluster + "/" + t.Namespace + "/" + t.Server
		if !dnsLabelRE.MatchString(t.Server) || !dnsLabelRE.MatchString(t.Namespace) || seen[key] {
			return plan, buildErrBadTarget
		}
		seen[key] = true
		plan.targets = append(plan.targets, t)
	}
	if !safeFolder(plan.dir) || !jarName(plan.filename) {
		return plan, buildErrBadPath
	}
	for _, name := range in.Remove {
		if !jarName(name) || name == plan.filename {
			return plan, buildErrBadPath
		}
		plan.remove = append(plan.remove, name)
	}
	return plan, ""
}

func safeFolder(dir string) bool {
	return dir != "." && !strings.HasPrefix(dir, "/") && path.Clean(dir) == dir && !strings.Contains(dir, "..")
}

func jarName(name string) bool {
	return strings.HasSuffix(name, ".jar") && len(name) > len(".jar") && !strings.Contains(name, "/")
}

func artifactOf(artifacts []buildArtifact, artifact string) (buildArtifact, bool) {
	i := slices.IndexFunc(artifacts, func(a buildArtifact) bool { return a.Path == artifact })
	if i < 0 {
		return buildArtifact{}, false
	}
	return artifacts[i], true
}

func permits(authorize func(http.Handler) http.Handler, req *http.Request, target string) bool {
	probe, err := http.NewRequestWithContext(req.Context(), http.MethodPost, target, http.NoBody)
	if err != nil {
		return false
	}
	allowed := false
	authorize(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { allowed = true })).ServeHTTP(httptest.NewRecorder(), probe)
	return allowed
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func randomID() string {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}
