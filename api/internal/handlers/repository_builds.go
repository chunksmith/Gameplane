package handlers

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"

	"github.com/GameplanePanel/gameplane/api/internal/audit"
	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/httperr"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
	"github.com/GameplanePanel/gameplane/api/internal/messages"
	"github.com/GameplanePanel/gameplane/api/internal/rbac"
	"github.com/GameplanePanel/gameplane/api/internal/ws"
)

const (
	buildToolAuto       = "auto"
	buildToolMaven      = "maven"
	buildToolGradle     = "gradle"
	buildPhaseSucceeded = "Succeeded"
	buildPhaseFailed    = "Failed"
	buildPhasePending   = "Pending"
	buildDefaultJDK     = 21
	buildKeep           = 10
	buildArgsMax        = 512
	buildNameMax        = 63
	buildDeploymentsMax = 20
	buildViaAssistant   = "assistant"
	buildViaDashboard   = "dashboard"

	buildLabelRepository       = "gameplane.local/repository"
	buildLabelNumber           = "gameplane.local/build-number"
	buildAnnotationStartedByID = "gameplane.local/started-by-id"
	buildAnnotationStartedBy   = "gameplane.local/started-by"
	buildAnnotationVia         = "gameplane.local/started-via"
	buildAnnotationDeployments = "gameplane.local/deployments"
	buildAnnotationClearCache  = "gameplane.local/clear-cache"

	buildErrActive          = "server.repositories.builds.active"
	buildErrNotReady        = "server.repositories.builds.not_ready"
	buildErrNoProject       = "server.repositories.builds.no_project"
	buildErrLogGone         = "server.repositories.builds.log_gone"
	buildErrNotSucceeded    = "server.repositories.builds.not_succeeded"
	buildErrArtifactUnknown = "server.repositories.builds.artifact_unknown"
	buildErrArtifactChanged = "server.repositories.builds.artifact_changed"
	buildErrBadTarget       = "server.repositories.builds.bad_target"
	buildErrTargetForbidden = "server.repositories.builds.target_forbidden"
	buildErrBadPath         = "server.repositories.builds.bad_path"
	buildErrBadSettings     = "server.repositories.builds.bad_settings"
	buildErrNotFound        = "server.repositories.builds.not_found"
)

var buildJDKs = []int32{17, 21, 25}

var buildTools = []string{buildToolAuto, buildToolMaven, buildToolGradle}

type buildSettings struct {
	Tool     string  `json:"tool"`
	Detected *string `json:"detected"`
	JDK      int32   `json:"jdk"`
	Args     string  `json:"args"`
	Publish  bool    `json:"publish"`
}

func (s buildSettings) valid() bool {
	return slices.Contains(buildTools, s.Tool) && slices.Contains(buildJDKs, s.JDK) && len(s.Args) <= buildArgsMax
}

type buildArtifact struct {
	Path   string `json:"path"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Shaded bool   `json:"shaded"`
}

type buildActor struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type buildDeploymentTarget struct {
	Cluster   string  `json:"cluster"`
	Namespace string  `json:"namespace"`
	Server    string  `json:"server"`
	OK        bool    `json:"ok"`
	Error     *string `json:"error"`
}

type buildDeployment struct {
	ID         string                  `json:"id"`
	Time       string                  `json:"time"`
	Artifact   string                  `json:"artifact"`
	Dir        string                  `json:"dir"`
	Filename   string                  `json:"filename"`
	Removed    []string                `json:"removed"`
	Restart    bool                    `json:"restart"`
	Actor      buildActor              `json:"actor"`
	Via        string                  `json:"via"`
	ApprovedBy *string                 `json:"approvedBy"`
	Targets    []buildDeploymentTarget `json:"targets"`
}

type buildLimits struct {
	CPU    string `json:"cpu"`
	Memory string `json:"memory"`
}

type buildSource struct {
	Commit  *string `json:"commit"`
	Changes int64   `json:"changes"`
}

type buildView struct {
	Number         int64             `json:"number"`
	Name           string            `json:"name"`
	Repository     string            `json:"repository"`
	Phase          string            `json:"phase"`
	Message        *string           `json:"message"`
	Tool           string            `json:"tool"`
	JDK            int32             `json:"jdk"`
	Args           string            `json:"args"`
	Publish        bool              `json:"publish"`
	Published      *bool             `json:"published"`
	Source         buildSource       `json:"source"`
	StartedBy      *buildActor       `json:"startedBy"`
	Via            string            `json:"via"`
	CreatedAt      string            `json:"createdAt"`
	StartTime      *string           `json:"startTime"`
	CompletionTime *string           `json:"completionTime"`
	Limits         buildLimits       `json:"limits"`
	Artifacts      []buildArtifact   `json:"artifacts"`
	Deployments    []buildDeployment `json:"deployments"`
}

type buildList struct {
	Builds     []buildView   `json:"builds"`
	Settings   buildSettings `json:"settings"`
	CacheBytes *int64        `json:"cacheBytes"`
	Keep       int           `json:"keep"`
}

type buildObject struct {
	Spec struct {
		Tool    string `json:"tool"`
		JDK     int32  `json:"jdk"`
		Args    string `json:"args"`
		Publish bool   `json:"publish"`
		Source  struct {
			Commit  string `json:"commit"`
			Changes int64  `json:"changes"`
		} `json:"source"`
	} `json:"spec"`
	Status struct {
		Phase          string                      `json:"phase"`
		Tool           string                      `json:"tool"`
		Message        string                      `json:"message"`
		StartTime      string                      `json:"startTime"`
		CompletionTime string                      `json:"completionTime"`
		Artifacts      []buildArtifact             `json:"artifacts"`
		Published      bool                        `json:"published"`
		Resources      corev1.ResourceRequirements `json:"resources"`
	} `json:"status"`
}

type repositoryBuildSpec struct {
	Tool    string `json:"tool"`
	JDK     int32  `json:"jdk"`
	Args    string `json:"args"`
	Publish *bool  `json:"publish"`
}

type buildOriginKey struct{}

type buildHandler struct {
	reg     *kube.Registry
	router  http.Handler
	auditor *audit.Auditor
}

func MountRepositoryBuilds(r chi.Router, reg *kube.Registry, router http.Handler, auditor *audit.Auditor) {
	h := &buildHandler{reg: reg, router: router, auditor: auditor}
	r = r.With(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if !rejectRemoteCluster(w, req) {
				next.ServeHTTP(w, req)
			}
		})
	})
	r.Get("/repositories/{name}/builds", h.list)
	r.Post("/repositories/{name}/builds", h.start)
	r.Post("/repositories/{name}/builds:clear-cache", h.clearCache)
	r.Put("/repositories/{name}/build", h.putSettings)
	r.Get("/repositories/{name}/builds/{number}", h.get)
	r.Delete("/repositories/{name}/builds/{number}", h.del)
	r.Get("/repositories/{name}/builds/{number}/log", h.log)
	r.Post("/repositories/{name}/builds/{number}/deploy", h.deploy)
}

func (h *buildHandler) repos(ns string) dynamic.ResourceInterface {
	return h.reg.Default().Dynamic.Resource(kube.GVRRepository).Namespace(ns)
}

func (h *buildHandler) builds(ns string) dynamic.ResourceInterface {
	return h.reg.Default().Dynamic.Resource(kube.GVRRepositoryBuild).Namespace(ns)
}

func (h *buildHandler) repository(w http.ResponseWriter, req *http.Request) (*unstructured.Unstructured, rbac.RepositoryGrant, bool) {
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

func requireBuildWrite(w http.ResponseWriter, req *http.Request, grant rbac.RepositoryGrant) bool {
	if !grant.Has(rbac.RepoWrite) {
		httperr.WriteMessage(w, req, messages.New(httperr.IDForbidden, nil))
		return false
	}
	return true
}

func (h *buildHandler) buildFor(w http.ResponseWriter, req *http.Request, repo *unstructured.Unstructured) (*unstructured.Unstructured, bool) {
	number, err := strconv.ParseInt(chi.URLParam(req, "number"), 10, 64)
	if err != nil || number < 1 {
		httperr.WriteMessage(w, req, messages.New(messages.ID(buildErrNotFound), nil))
		return nil, false
	}
	obj, err := h.builds(repo.GetNamespace()).Get(req.Context(), buildName(repo.GetName(), number), metav1.GetOptions{})
	switch {
	case apierrors.IsNotFound(err) || err == nil && obj.GetLabels()[buildLabelRepository] != repo.GetName():
		httperr.WriteMessage(w, req, messages.New(messages.ID(buildErrNotFound), nil))
		return nil, false
	case err != nil:
		httperr.Write(w, req, err)
		return nil, false
	}
	return obj, true
}

func (h *buildHandler) listBuilds(ctx context.Context, repo *unstructured.Unstructured) ([]unstructured.Unstructured, error) {
	list, err := h.builds(repo.GetNamespace()).List(ctx, metav1.ListOptions{LabelSelector: buildLabelRepository + "=" + repo.GetName()})
	if err != nil {
		return nil, err
	}
	slices.SortFunc(list.Items, func(a, b unstructured.Unstructured) int {
		return cmp.Compare(buildNumberOf(b), buildNumberOf(a))
	})
	return list.Items, nil
}

func (h *buildHandler) list(w http.ResponseWriter, req *http.Request) {
	repo, _, ok := h.repository(w, req)
	if !ok {
		return
	}
	items, err := h.listBuilds(req.Context(), repo)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	out := buildList{Builds: make([]buildView, 0, len(items)), Settings: h.settings(req, repo), Keep: buildKeep}
	for i := range items {
		view, err := toBuildView(&items[i])
		if err != nil {
			httperr.Write(w, req, err)
			return
		}
		out.Builds = append(out.Builds, view)
		if out.CacheBytes == nil && buildFinished(view.Phase) {
			cache, _, _ := unstructured.NestedInt64(items[i].Object, "status", "cacheBytes")
			out.CacheBytes = &cache
		}
	}
	writeJSON(w, out)
}

func (h *buildHandler) get(w http.ResponseWriter, req *http.Request) {
	repo, _, ok := h.repository(w, req)
	if !ok {
		return
	}
	obj, ok := h.buildFor(w, req, repo)
	if !ok {
		return
	}
	view, err := toBuildView(obj)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	writeJSON(w, view)
}

func (h *buildHandler) start(w http.ResponseWriter, req *http.Request) {
	repo, grant, ok := h.repository(w, req)
	if !ok || !requireBuildWrite(w, req, grant) {
		return
	}
	var body struct {
		Tool string  `json:"tool"`
		JDK  int32   `json:"jdk"`
		Args *string `json:"args"`
	}
	if err := json.NewDecoder(io.LimitReader(req.Body, 1<<16)).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		httperr.WriteMessage(w, req, messages.New("server.common.invalid_json", nil))
		return
	}
	ctx := req.Context()
	items, err := h.listBuilds(ctx, repo)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	if buildsActive(items) {
		httperr.WriteMessage(w, req, messages.New(messages.ID(buildErrActive), nil))
		return
	}
	if !repositoryAgentReady(repo) {
		httperr.WriteMessage(w, req, messages.New(messages.ID(buildErrNotReady), nil))
		return
	}
	status, data := routerCall(ctx, h.router, aiCredentials(req), http.MethodGet, "/repositories/"+repo.GetName()+"/git/status?"+url.Values{"namespace": {repo.GetNamespace()}}.Encode(), nil, "")
	var git ws.RepoStatus
	if status != http.StatusOK || json.Unmarshal(data, &git) != nil {
		httperr.WriteMessage(w, req, messages.New(messages.ID(buildErrNotReady), nil))
		return
	}
	defaults := repositoryBuildDefaults(repo)
	args := defaults.Args
	if body.Args != nil {
		args = *body.Args
	}
	settings := buildSettings{
		Tool: cmp.Or(body.Tool, defaults.Tool), JDK: cmp.Or(body.JDK, defaults.JDK), Args: args, Publish: defaults.Publish,
	}
	if !settings.valid() {
		httperr.WriteMessage(w, req, messages.New(messages.ID(buildErrBadSettings), nil))
		return
	}
	if settings.Tool == buildToolAuto {
		detected := h.detect(req, repo)
		if detected == nil {
			httperr.WriteMessage(w, req, messages.New(messages.ID(buildErrNoProject), nil))
			return
		}
		settings.Tool = *detected
	}
	var commit string
	if git.Head != nil {
		commit = *git.Head
	}
	commit = commit[:min(len(commit), 7)]
	var number int64
	for _, item := range items {
		number = max(number, buildNumberOf(item))
	}
	number++
	via := buildOrigin(ctx)
	var created *unstructured.Unstructured
	for range 5 {
		created, err = h.builds(repo.GetNamespace()).Create(ctx, newBuildObject(repo, number, settings, commit, int64(len(git.Changes)), auth.UserFromContext(ctx), via), metav1.CreateOptions{})
		if !apierrors.IsAlreadyExists(err) {
			break
		}
		current, listErr := h.listBuilds(ctx, repo)
		if listErr != nil {
			httperr.Write(w, req, listErr)
			return
		}
		if buildsActive(current) {
			httperr.WriteMessage(w, req, messages.New(messages.ID(buildErrActive), nil))
			return
		}
		number++
	}
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	view, err := toBuildView(created)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	if !h.record(w, req, created.GetName(), fmt.Sprintf("repository.build.start number=%d via=%s", number, via), http.StatusCreated) {
		return
	}
	writeJSONCreated(w, view)
}

func (h *buildHandler) del(w http.ResponseWriter, req *http.Request) {
	repo, grant, ok := h.repository(w, req)
	if !ok || !requireBuildWrite(w, req, grant) {
		return
	}
	obj, ok := h.buildFor(w, req, repo)
	if !ok {
		return
	}
	background := metav1.DeletePropagationBackground
	if err := h.builds(repo.GetNamespace()).Delete(req.Context(), obj.GetName(), metav1.DeleteOptions{PropagationPolicy: &background}); err != nil {
		httperr.Write(w, req, err)
		return
	}
	if !h.record(w, req, obj.GetName(), "repository.build.delete", http.StatusNoContent) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *buildHandler) log(w http.ResponseWriter, req *http.Request) {
	repo, _, ok := h.repository(w, req)
	if !ok {
		return
	}
	obj, ok := h.buildFor(w, req, repo)
	if !ok {
		return
	}
	pods, err := h.reg.Default().Typed.CoreV1().Pods(repo.GetNamespace()).List(req.Context(), metav1.ListOptions{LabelSelector: "job-name=" + buildJobName(obj.GetName())})
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	if len(pods.Items) == 0 {
		httperr.WriteMessage(w, req, messages.New(messages.ID(buildErrLogGone), nil))
		return
	}
	pod := pods.Items[0]
	for _, candidate := range pods.Items[1:] {
		if candidate.CreationTimestamp.After(pod.CreationTimestamp.Time) {
			pod = candidate
		}
	}
	query := req.URL.Query()
	opts := &corev1.PodLogOptions{Container: "build", Follow: query.Get("follow") == "1"}
	if tail, err := strconv.ParseInt(query.Get("tail"), 10, 64); err == nil && tail > 0 {
		opts.TailLines = &tail
	}
	stream, err := h.reg.Default().Typed.CoreV1().Pods(repo.GetNamespace()).GetLogs(pod.Name, opts).Stream(req.Context())
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	defer func() { _ = stream.Close() }()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.Copy(flushWriter{w}, stream)
}

func (h *buildHandler) clearCache(w http.ResponseWriter, req *http.Request) {
	repo, grant, ok := h.repository(w, req)
	if !ok || !requireBuildWrite(w, req, grant) {
		return
	}
	items, err := h.listBuilds(req.Context(), repo)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	if buildsActive(items) {
		httperr.WriteMessage(w, req, messages.New(messages.ID(buildErrActive), nil))
		return
	}
	stamp := time.Now().UTC().Format(time.RFC3339)
	if err := h.patchRepository(req.Context(), repo, map[string]any{"metadata": map[string]any{"annotations": map[string]any{buildAnnotationClearCache: stamp}}}); err != nil {
		httperr.Write(w, req, err)
		return
	}
	if !h.record(w, req, repo.GetName(), "repository.build.clear-cache", http.StatusAccepted) {
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (h *buildHandler) putSettings(w http.ResponseWriter, req *http.Request) {
	repo, grant, ok := h.repository(w, req)
	if !ok || !requireBuildWrite(w, req, grant) {
		return
	}
	var body buildSettings
	if err := json.NewDecoder(io.LimitReader(req.Body, 1<<16)).Decode(&body); err != nil {
		httperr.WriteMessage(w, req, messages.New("server.common.invalid_json", nil))
		return
	}
	if !body.valid() {
		httperr.WriteMessage(w, req, messages.New(messages.ID(buildErrBadSettings), nil))
		return
	}
	build := map[string]any{"tool": body.Tool, "jdk": int64(body.JDK), "args": body.Args, "publish": body.Publish}
	if err := h.patchRepository(req.Context(), repo, map[string]any{"spec": map[string]any{"build": build}}); err != nil {
		httperr.Write(w, req, err)
		return
	}
	if !h.record(w, req, repo.GetName(), "repository.build.settings", http.StatusOK) {
		return
	}
	body.Detected = h.detect(req, repo)
	writeJSON(w, body)
}

func (h *buildHandler) patchRepository(ctx context.Context, repo *unstructured.Unstructured, patch any) error {
	data, err := json.Marshal(patch)
	if err != nil {
		return fmt.Errorf("encode repository patch: %w", err)
	}
	_, err = h.repos(repo.GetNamespace()).Patch(ctx, repo.GetName(), types.MergePatchType, data, metav1.PatchOptions{})
	return err
}

func (h *buildHandler) settings(req *http.Request, repo *unstructured.Unstructured) buildSettings {
	settings := repositoryBuildDefaults(repo)
	settings.Detected = h.detect(req, repo)
	return settings
}

func (h *buildHandler) detect(req *http.Request, repo *unstructured.Unstructured) *string {
	if !repositoryAgentReady(repo) {
		return nil
	}
	query := url.Values{"path": {"/"}, "namespace": {repo.GetNamespace()}}
	status, data := routerCall(req.Context(), h.router, aiCredentials(req), http.MethodGet, "/repositories/"+repo.GetName()+"/files/list?"+query.Encode(), nil, "")
	var entries []aiListEntry
	if status != http.StatusOK || json.Unmarshal(data, &entries) != nil {
		return nil
	}
	return detectBuildTool(entries)
}

func (h *buildHandler) record(w http.ResponseWriter, req *http.Request, target, reason string, status int) bool {
	if h.auditor == nil {
		return true
	}
	if err := h.auditor.WriteSync(req.Context(), req.Method, req.URL.Path, target, reason, status); err != nil {
		httperr.WriteCode(w, req, http.StatusInternalServerError, errors.New("audit write failed"))
		return false
	}
	audit.MarkRecorded(req.Context())
	return true
}

func detectBuildTool(entries []aiListEntry) *string {
	files := map[string]bool{}
	for _, entry := range entries {
		if !entry.Dir {
			files[entry.Name] = true
		}
	}
	switch {
	case files["pom.xml"]:
		tool := buildToolMaven
		return &tool
	case files["build.gradle"], files["build.gradle.kts"]:
		tool := buildToolGradle
		return &tool
	}
	return nil
}

func repositoryBuildDefaults(repo *unstructured.Unstructured) buildSettings {
	var spec repositoryBuildSpec
	if raw, found, _ := unstructured.NestedFieldNoCopy(repo.Object, "spec", "build"); found {
		_ = unstructuredInto(raw, &spec)
	}
	return buildSettings{
		Tool: cmp.Or(spec.Tool, buildToolAuto), JDK: cmp.Or(spec.JDK, buildDefaultJDK), Args: spec.Args,
		Publish: spec.Publish == nil || *spec.Publish,
	}
}

func newBuildObject(repo *unstructured.Unstructured, number int64, settings buildSettings, commit string, changes int64, user *auth.User, via string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "gameplane.local/v1alpha1",
		"kind":       "RepositoryBuild",
		"metadata": map[string]any{
			"name":      buildName(repo.GetName(), number),
			"namespace": repo.GetNamespace(),
			"labels": map[string]any{
				buildLabelRepository: repo.GetName(),
				buildLabelNumber:     strconv.FormatInt(number, 10),
			},
			"annotations": map[string]any{
				buildAnnotationStartedByID: strconv.FormatInt(user.ID, 10),
				buildAnnotationStartedBy:   cmp.Or(user.DisplayName, user.Username),
				buildAnnotationVia:         via,
			},
			"ownerReferences": []any{map[string]any{
				"apiVersion": "gameplane.local/v1alpha1", "kind": "Repository", "name": repo.GetName(), "uid": string(repo.GetUID()),
				"controller": true, "blockOwnerDeletion": true,
			}},
		},
		"spec": map[string]any{
			"repositoryRef": repo.GetName(), "tool": settings.Tool, "jdk": int64(settings.JDK), "args": settings.Args, "publish": settings.Publish,
			"source": map[string]any{"commit": commit, "changes": changes},
		},
	}}
}

func toBuildView(obj *unstructured.Unstructured) (buildView, error) {
	var cr buildObject
	if err := unstructuredInto(obj.Object, &cr); err != nil {
		return buildView{}, err
	}
	annotations := obj.GetAnnotations()
	view := buildView{
		Number: buildNumberOf(*obj), Name: obj.GetName(), Repository: obj.GetLabels()[buildLabelRepository],
		Phase: cmp.Or(cr.Status.Phase, buildPhasePending), Tool: cmp.Or(cr.Status.Tool, cr.Spec.Tool), JDK: cr.Spec.JDK, Args: cr.Spec.Args, Publish: cr.Spec.Publish,
		Source:    buildSource{Changes: cr.Spec.Source.Changes},
		Via:       cmp.Or(annotations[buildAnnotationVia], buildViaDashboard),
		CreatedAt: obj.GetCreationTimestamp().UTC().Format(time.RFC3339),
		Limits:    buildLimits{CPU: quantityOf(cr.Status.Resources.Limits, corev1.ResourceCPU), Memory: quantityOf(cr.Status.Resources.Limits, corev1.ResourceMemory)},
		Artifacts: []buildArtifact{}, Deployments: []buildDeployment{},
	}
	if cr.Spec.Source.Commit != "" {
		commit := cr.Spec.Source.Commit
		view.Source.Commit = &commit
	}
	if id := annotations[buildAnnotationStartedByID]; id != "" {
		view.StartedBy = &buildActor{ID: id, Name: annotations[buildAnnotationStartedBy]}
	}
	if cr.Status.Message != "" {
		message := cr.Status.Message
		view.Message = &message
	}
	if cr.Status.StartTime != "" {
		start := cr.Status.StartTime
		view.StartTime = &start
	}
	if cr.Status.CompletionTime != "" {
		done := cr.Status.CompletionTime
		view.CompletionTime = &done
	}
	if buildFinished(view.Phase) && view.Publish {
		published := cr.Status.Published
		view.Published = &published
	}
	for _, artifact := range cr.Status.Artifacts {
		artifact.Name = path.Base(artifact.Path)
		view.Artifacts = append(view.Artifacts, artifact)
	}
	_ = json.Unmarshal([]byte(annotations[buildAnnotationDeployments]), &view.Deployments)
	return view, nil
}

func quantityOf(list corev1.ResourceList, name corev1.ResourceName) string {
	if quantity, ok := list[name]; ok {
		return quantity.String()
	}
	return ""
}

func buildsActive(items []unstructured.Unstructured) bool {
	return slices.ContainsFunc(items, func(item unstructured.Unstructured) bool {
		phase, _, _ := unstructured.NestedString(item.Object, "status", "phase")
		return !buildFinished(phase)
	})
}

func buildFinished(phase string) bool {
	return phase == buildPhaseSucceeded || phase == buildPhaseFailed
}

func buildNumberOf(obj unstructured.Unstructured) int64 {
	number, _ := strconv.ParseInt(obj.GetLabels()[buildLabelNumber], 10, 64)
	return number
}

func buildName(repo string, number int64) string {
	return fmt.Sprintf("%s-build-%d", repo, number)
}

func buildJobName(name string) string {
	if len(name) <= buildNameMax {
		return name
	}
	sum := sha256.Sum256([]byte(name))
	suffix := "-" + hex.EncodeToString(sum[:])[:8]
	return strings.TrimRight(name[:buildNameMax-len(suffix)], "-") + suffix
}

func unstructuredInto(from, to any) error {
	data, err := json.Marshal(from)
	if err != nil {
		return fmt.Errorf("encode object: %w", err)
	}
	if err := json.Unmarshal(data, to); err != nil {
		return fmt.Errorf("decode object: %w", err)
	}
	return nil
}

func withAssistantOrigin(ctx context.Context) context.Context {
	return context.WithValue(ctx, buildOriginKey{}, buildViaAssistant)
}

func buildOrigin(ctx context.Context) string {
	if via, _ := ctx.Value(buildOriginKey{}).(string); via == buildViaAssistant {
		return via
	}
	return buildViaDashboard
}

type flushWriter struct {
	http.ResponseWriter
}

func (f flushWriter) Write(p []byte) (int, error) {
	n, err := f.ResponseWriter.Write(p)
	if flusher, ok := f.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
	return n, err
}
