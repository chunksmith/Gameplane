package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/GameplanePanel/gameplane/api/internal/httperr"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
	"github.com/GameplanePanel/gameplane/api/internal/messages"
	"github.com/GameplanePanel/gameplane/netguard"
)

const destinationUsageTTL = time.Hour

type destinationUsage struct {
	Bytes     int64     `json:"bytes"`
	Objects   int64     `json:"objects"`
	CheckedAt time.Time `json:"checkedAt"`
}

type usageKey struct {
	client    *kube.Client
	namespace string
	name      string
	repo      string
}

type usageCache struct {
	mu      sync.Mutex
	entries map[usageKey]destinationUsage
}

func (c *usageCache) get(key usageKey) (destinationUsage, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	usage, ok := c.entries[key]
	return usage, ok && time.Since(usage.CheckedAt) < destinationUsageTTL
}

func (c *usageCache) put(key usageKey, usage destinationUsage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = usage
}

type s3Target struct {
	endpoint string
	bucket   string
	prefix   string
	secure   bool
}

func parseS3Repo(repo string) (s3Target, bool) {
	rest, ok := strings.CutPrefix(repo, "s3:")
	if !ok {
		return s3Target{}, false
	}
	if !strings.Contains(rest, "://") {
		rest = "https://" + rest
	}
	parsed, err := url.Parse(rest)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return s3Target{}, false
	}
	bucket, prefix, _ := strings.Cut(strings.Trim(parsed.Path, "/"), "/")
	if bucket == "" {
		return s3Target{}, false
	}
	return s3Target{endpoint: parsed.Host, bucket: bucket, prefix: prefix, secure: parsed.Scheme == "https"}, true
}

func scanS3Usage(ctx context.Context, target s3Target, data map[string][]byte) (destinationUsage, error) {
	client, err := minio.New(target.endpoint, &minio.Options{
		Creds:     credentials.NewStaticV4(string(data["AWS_ACCESS_KEY_ID"]), string(data["AWS_SECRET_ACCESS_KEY"]), string(data["AWS_SESSION_TOKEN"])),
		Secure:    target.secure,
		Region:    string(data["AWS_DEFAULT_REGION"]),
		Transport: netguard.HTTPClient(time.Minute, netguard.IsAllowed).Transport,
	})
	if err != nil {
		return destinationUsage{}, fmt.Errorf("s3 client init: %w", err)
	}
	prefix := target.prefix
	if prefix != "" {
		prefix += "/"
	}
	usage := destinationUsage{CheckedAt: time.Now().UTC()}
	for object := range client.ListObjects(ctx, target.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
		if object.Err != nil {
			return destinationUsage{}, fmt.Errorf("list bucket %s: %w", target.bucket, object.Err)
		}
		usage.Bytes += object.Size
		usage.Objects++
	}
	return usage, nil
}

func (h destinationHandler) usage(w http.ResponseWriter, req *http.Request) {
	k, ok := resolveCluster(w, req, h.reg)
	if !ok {
		return
	}
	ns, ok := resolveNS(w, req)
	if !ok {
		return
	}
	name := chi.URLParam(req, "name")
	secret, err := k.Typed.CoreV1().Secrets(ns).Get(req.Context(), name, metav1.GetOptions{})
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	if !isDestination(secret) {
		httperr.Write(w, req, apierrors.NewNotFound(corev1.Resource("secrets"), name))
		return
	}
	repo := project(secret).URL
	target, ok := parseS3Repo(repo)
	if !ok {
		httperr.WriteMessage(w, req, messages.New("server.backup_destinations.usage_unsupported", nil))
		return
	}
	key := usageKey{client: k, namespace: ns, name: name, repo: repo}
	if usage, ok := h.usageCache.get(key); ok && req.URL.Query().Get("refresh") != "true" {
		writeJSON(w, usage)
		return
	}
	ctx, cancel := context.WithTimeout(req.Context(), 2*time.Minute)
	defer cancel()
	usage, err := scanS3Usage(ctx, target, secret.Data)
	if err != nil {
		slog.Warn("backup destination usage", "namespace", ns, "name", name, "err", err)
		httperr.WriteMessage(w, req, messages.New("server.backup_destinations.usage_unavailable", nil))
		return
	}
	h.usageCache.put(key, usage)
	writeJSON(w, usage)
}
