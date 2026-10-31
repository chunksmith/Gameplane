package heartbeat

import (
	"context"
	"log/slog"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

// AwaitRelease blocks until the named GameServer exists, is not suspended and
// holds no wipe or restore guard.
func AwaitRelease(ctx context.Context, serverName string, interval time.Duration) error {
	restCfg, err := rest.InClusterConfig()
	if err != nil {
		return err
	}
	dyn, err := dynamic.NewForConfig(restCfg)
	if err != nil {
		return err
	}
	return awaitRelease(ctx, dyn.Resource(gvr).Namespace(readNamespace()), serverName, interval)
}

func awaitRelease(ctx context.Context, servers dynamic.ResourceInterface, serverName string, interval time.Duration) error {
	for {
		server, err := servers.Get(ctx, serverName, metav1.GetOptions{})
		if err != nil {
			slog.Warn("hold: get server", "server", serverName, "err", err)
		} else if released(server) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
	}
}

func released(server *unstructured.Unstructured) bool {
	suspended, _, _ := unstructured.NestedBool(server.Object, "spec", "suspend")
	annotations := server.GetAnnotations()
	return !suspended && annotations["gameplane.local/wipe-owner"] == "" && annotations["restore.gameplane.local/owner"] == ""
}
