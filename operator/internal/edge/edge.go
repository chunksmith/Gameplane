package edge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"slices"
	"sync"
	"time"
)

type Provider interface {
	SetEnabled(ctx context.Context, backend string, enabled bool) error
}

type Registry struct {
	mutex     sync.Mutex
	http      *http.Client
	providers map[string]Provider
}

func NewRegistry() *Registry {
	return &Registry{http: &http.Client{Timeout: 10 * time.Second}, providers: map[string]Provider{}}
}

func (registry *Registry) Get(provider, token string, config map[string]string) (Provider, error) {
	key := cacheKey(provider, token, config)
	registry.mutex.Lock()
	defer registry.mutex.Unlock()
	if existing, ok := registry.providers[key]; ok {
		return existing, nil
	}
	var created Provider
	switch provider {
	case "infinity-filter":
		network := config["networkId"]
		if network == "" {
			return nil, fmt.Errorf("edge %s: config.networkId is required", provider)
		}
		created = newInfinityFilter(registry.http, token, network)
	default:
		return nil, fmt.Errorf("edge: unknown provider %q", provider)
	}
	registry.providers[key] = created
	return created, nil
}

func cacheKey(provider, token string, config map[string]string) string {
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
