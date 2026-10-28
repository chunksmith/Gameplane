package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
	utilexec "k8s.io/client-go/util/exec"

	"github.com/GameplanePanel/gameplane/api/internal/audit"
	"github.com/GameplanePanel/gameplane/api/internal/httperr"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
	"github.com/GameplanePanel/gameplane/api/internal/messages"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

const (
	shellDefaultTimeout = 30 * time.Second
	shellAuditTarget    = 200
)

type shellRequest struct {
	Command        string `json:"command"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
}

type shellResponse struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
}

func mountShell(r chi.Router, reg *kube.Registry, auditor *audit.Auditor) {
	r.Post("/servers/{name}/shell", func(w http.ResponseWriter, req *http.Request) {
		k, ok := streamClient(w, req, reg)
		if !ok {
			return
		}
		if k.Config == nil {
			http.Error(w, "cluster unavailable", http.StatusServiceUnavailable)
			return
		}
		runShell(w, req, k, auditor)
	})
}

func runShell(w http.ResponseWriter, req *http.Request, k *kube.Client, auditor *audit.Auditor) {
	name := chi.URLParam(req, "name")
	ns, err := scope.Resolve(req)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	if len(validation.IsDNS1123Subdomain(name)) != 0 {
		httperr.WriteMessage(w, req, messages.New("server.ws.invalid_server_name", nil))
		return
	}
	pod, err := serverPod(req.Context(), k, ns, name)
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	body, err := decodeShell(req.Body)
	if err != nil {
		httperr.Write(w, req, apierrors.NewBadRequest(err.Error()))
		return
	}
	ctx, cancel := context.WithTimeout(req.Context(), shellTimeout(body.TimeoutSeconds))
	defer cancel()
	out, err := execShell(ctx, k, pod, body.Command)
	status := http.StatusOK
	if err != nil {
		status = http.StatusInternalServerError
	}
	if auditor != nil && auditor.WriteSync(req.Context(), http.MethodPost, req.URL.Path, clipRunes(body.Command, shellAuditTarget), "", status) == nil {
		audit.MarkRecorded(req.Context())
	}
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func decodeShell(r io.Reader) (shellRequest, error) {
	var body shellRequest
	if err := json.NewDecoder(r).Decode(&body); err != nil {
		return body, fmt.Errorf("invalid shell request: %w", err)
	}
	if strings.TrimSpace(body.Command) == "" {
		return body, errors.New("command must be non-empty")
	}
	return body, nil
}

func shellTimeout(seconds int) time.Duration {
	if seconds <= 0 {
		return shellDefaultTimeout
	}
	return time.Duration(seconds) * time.Second
}

func dataMountPath(pod *corev1.Pod) string {
	for _, container := range pod.Spec.Containers {
		if container.Name != "game" {
			continue
		}
		for _, mount := range container.VolumeMounts {
			if mount.Name == "data" {
				return mount.MountPath
			}
		}
	}
	return "/data"
}

func execShell(ctx context.Context, k *kube.Client, pod *corev1.Pod, command string) (shellResponse, error) {
	target := k.Typed.CoreV1().RESTClient().Post().
		Resource("pods").
		Name(pod.Name).
		Namespace(pod.Namespace).
		SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: "game",
			Command:   []string{"sh", "-c", `cd "$0" && exec sh -c "$1"`, dataMountPath(pod), command},
			Stdout:    true,
			Stderr:    true,
		}, scheme.ParameterCodec).
		URL()
	executor, err := k.NewSPDYExecutor(http.MethodPost, target)
	if err != nil {
		return shellResponse{}, fmt.Errorf("build shell executor for pod %s/%s: %w", pod.Namespace, pod.Name, err)
	}
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	err = executor.StreamWithContext(ctx, remotecommand.StreamOptions{Stdout: stdout, Stderr: stderr})
	out := shellResponse{Stdout: stdout.String(), Stderr: stderr.String()}
	return shellResult(ctx, out, err, pod)
}

func shellResult(ctx context.Context, out shellResponse, err error, pod *corev1.Pod) (shellResponse, error) {
	var exitErr utilexec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &exitErr):
		out.ExitCode = exitErr.ExitStatus()
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		out.ExitCode = 124
		out.Stderr += "\ncommand timed out"
	default:
		return out, fmt.Errorf("run shell in pod %s/%s: %w", pod.Namespace, pod.Name, err)
	}
	return out, nil
}

func clipRunes(text string, limit int) string {
	if runes := []rune(text); len(runes) > limit {
		return string(runes[:limit])
	}
	return text
}
