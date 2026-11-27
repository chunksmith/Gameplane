package handlers

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/GameplanePanel/gameplane/api/internal/httperr"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
	"github.com/GameplanePanel/gameplane/api/internal/messages"
)

const (
	mavenReadName     = "gameplane-maven-read"
	mavenPublicURLEnv = "GAMEPLANE_MAVEN_PUBLIC_URL"
)

type mavenIntegration struct {
	Enabled   bool    `json:"enabled"`
	URL       *string `json:"url"`
	State     string  `json:"state"`
	Artifacts *int64  `json:"artifacts"`
	Bytes     *int64  `json:"bytes"`
	AdminURL  *string `json:"adminUrl"`
}

type mavenIntegrationHandler struct {
	k8s        *kube.Client
	namespace  string
	publicURL  string
	httpClient *http.Client
}

// MountMavenIntegration wires GET /integrations/maven (spec 030).
func MountMavenIntegration(r chi.Router, k8s *kube.Client, namespace string) {
	h := mavenIntegrationHandler{k8s: k8s, namespace: namespace, publicURL: os.Getenv(mavenPublicURLEnv), httpClient: &http.Client{Timeout: 3 * time.Second}}
	r.Get("/integrations/maven", h.get)
}

func (h mavenIntegrationHandler) get(w http.ResponseWriter, req *http.Request) {
	if isRemoteCluster(req) {
		httperr.WriteMessage(w, req, messages.New(httperr.IDForbidden, nil))
		return
	}
	out := mavenIntegration{State: "disabled"}
	secret, err := h.k8s.Typed.CoreV1().Secrets(h.namespace).Get(req.Context(), mavenReadName, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		writeJSON(w, out)
		return
	}
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	out.Enabled, out.State = true, "unavailable"
	if h.publicURL != "" {
		admin := strings.TrimSuffix(h.publicURL, "/releases")
		out.URL, out.AdminURL = &h.publicURL, &admin
	}
	if h.running(req.Context(), secret.Data) {
		out.State = "running"
	}
	writeJSON(w, out)
}

func (h mavenIntegrationHandler) running(ctx context.Context, credentials map[string][]byte) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://gameplane-maven.%s.svc:8080/api/status/instance", h.namespace), nil)
	if err != nil {
		return false
	}
	req.SetBasicAuth(string(credentials["username"]), string(credentials["token"]))
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices
}
