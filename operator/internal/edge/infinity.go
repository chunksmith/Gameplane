package edge

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	infinityBaseURL  = "https://api.infinity-filter.com"
	infinityCacheTTL = 30 * time.Second
)

type infinityFilter struct {
	http    *http.Client
	base    string
	token   string
	network string
	mutex   sync.Mutex
	enabled map[string]bool
	fetched time.Time
}

func newInfinityFilter(client *http.Client, token, network string) *infinityFilter {
	return &infinityFilter{http: client, base: infinityBaseURL, token: token, network: network}
}

func (filter *infinityFilter) SetEnabled(ctx context.Context, backend string, enabled bool) error {
	filter.mutex.Lock()
	defer filter.mutex.Unlock()
	if time.Since(filter.fetched) > infinityCacheTTL {
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
