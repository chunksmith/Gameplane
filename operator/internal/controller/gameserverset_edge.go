package controller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	infinityFilterBaseURL  = "https://api.infinity-filter.com"
	infinityFilterCacheTTL = 30 * time.Second
)

type edgeProvider interface {
	SetEnabled(ctx context.Context, backend string, enabled bool) error
}

type edgeRegistry struct {
	mutex     sync.Mutex
	http      *http.Client
	providers map[string]edgeProvider
}

func newEdgeRegistry() *edgeRegistry {
	return &edgeRegistry{http: &http.Client{Timeout: 10 * time.Second}, providers: map[string]edgeProvider{}}
}

func (registry *edgeRegistry) get(provider, token string, config map[string]string) (edgeProvider, error) {
	key := edgeCacheKey(provider, token, config)
	registry.mutex.Lock()
	defer registry.mutex.Unlock()
	if existing, ok := registry.providers[key]; ok {
		return existing, nil
	}
	var created edgeProvider
	switch provider {
	case "infinity-filter":
		network := config["networkId"]
		if network == "" {
			return nil, fmt.Errorf("edge %s: config.networkId is required", provider)
		}
		created = &infinityFilter{http: registry.http, base: infinityFilterBaseURL, token: token, network: network}
	default:
		return nil, fmt.Errorf("edge: unknown provider %q", provider)
	}
	registry.providers[key] = created
	return created, nil
}

func edgeCacheKey(provider, token string, config map[string]string) string {
	hash := sha256.New()
	hash.Write([]byte(provider + "\x00" + token))
	keys := make([]string, 0, len(config))
	for key := range config {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	for _, key := range keys {
		hash.Write([]byte("\x00" + key + "=" + config[key]))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

type infinityFilter struct {
	http    *http.Client
	base    string
	token   string
	network string
	mutex   sync.Mutex
	enabled map[string]bool
	fetched time.Time
}

func (filter *infinityFilter) SetEnabled(ctx context.Context, backend string, enabled bool) error {
	filter.mutex.Lock()
	defer filter.mutex.Unlock()
	if time.Since(filter.fetched) > infinityFilterCacheTTL {
		if err := filter.refresh(ctx); err != nil {
			return err
		}
	}
	if current, ok := filter.enabled[backend]; ok && current == enabled {
		return nil
	}
	body := fmt.Sprintf(`{"enabled":%t}`, enabled)
	if _, err := filter.call(ctx, http.MethodPatch, "/backends/"+url.PathEscape(backend), body); err != nil {
		filter.fetched = time.Time{}
		return err
	}
	filter.enabled[backend] = enabled
	return nil
}

func (filter *infinityFilter) refresh(ctx context.Context) error {
	data, err := filter.call(ctx, http.MethodGet, "/backends", "")
	if err != nil {
		return err
	}
	var backends []struct {
		ID      json.Number `json:"id"`
		Enabled bool        `json:"enabled"`
	}
	if err := json.Unmarshal(data, &backends); err != nil {
		return fmt.Errorf("infinity-filter: decode backends: %w", err)
	}
	filter.enabled = make(map[string]bool, len(backends))
	for _, backend := range backends {
		filter.enabled[backend.ID.String()] = backend.Enabled
	}
	filter.fetched = time.Now()
	return nil
}

func (filter *infinityFilter) call(ctx context.Context, method, path, body string) ([]byte, error) {
	target := filter.base + "/networks/" + url.PathEscape(filter.network) + path
	request, err := http.NewRequestWithContext(ctx, method, target, strings.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("infinity-filter: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+filter.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := filter.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("infinity-filter: %s %s: %w", method, path, err)
	}
	defer func() { _ = response.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("infinity-filter: read %s: %w", path, err)
	}
	if response.StatusCode/100 != 2 {
		return nil, fmt.Errorf("infinity-filter: %s %s: status %d: %.200s", method, path, response.StatusCode, data)
	}
	return data, nil
}
