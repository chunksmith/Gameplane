package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	kubefake "k8s.io/client-go/kubernetes/fake"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
	"github.com/GameplanePanel/gameplane/api/internal/prom"
	"github.com/GameplanePanel/gameplane/api/internal/rbac"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

type fakeSeries struct {
	match  string
	labels map[string]string
	value  string
}

func fakePrometheus(t *testing.T, series ...fakeSeries) *prom.Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var results []map[string]any
		for _, item := range series {
			if !strings.Contains(req.URL.Query().Get("query"), item.match) {
				continue
			}
			result := map[string]any{"metric": item.labels}
			if strings.HasSuffix(req.URL.Path, "query_range") {
				result["values"] = [][]any{{1700000000, item.value}}
			} else {
				result["value"] = []any{1700000000, item.value}
			}
			results = append(results, result)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "success",
			"data":   map[string]any{"resultType": "vector", "result": results},
		})
	}))
	t.Cleanup(server.Close)
	client, err := prom.New(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func deadPrometheus(t *testing.T) *prom.Client {
	t.Helper()
	server := httptest.NewServer(http.NotFoundHandler())
	address := server.URL
	server.Close()
	client, err := prom.New(address)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func statisticsKube(objects ...runtime.Object) *kube.Client {
	k := fakeKubeClient()
	k.Typed = kubefake.NewClientset(objects...)
	return k
}

func gamePod(namespace, name, node string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Spec: corev1.PodSpec{
			NodeName: node,
			Containers: []corev1.Container{{
				Name: "game",
				Resources: corev1.ResourceRequirements{
					Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("500m"), corev1.ResourceMemory: resource.MustParse("1Gi")},
					Limits:   corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("2"), corev1.ResourceMemory: resource.MustParse("2Gi")},
				},
			}},
		},
		Status: corev1.PodStatus{
			Phase:             corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{{Name: "game", RestartCount: 3}},
		},
	}
}

func statisticsRouter(reg *kube.Registry, p *prom.Client) chi.Router {
	r := chi.NewRouter()
	r.Use(rbac.Middleware(reg))
	MountStatistics(r, reg, p)
	return r
}

func statisticsUser(grants map[string]map[string][]string) *auth.User {
	perms := map[string]map[string]map[string]struct{}{}
	for cluster, namespaces := range grants {
		perms[cluster] = map[string]map[string]struct{}{}
		for namespace, names := range namespaces {
			set := map[string]struct{}{}
			for _, name := range names {
				set[name] = struct{}{}
			}
			perms[cluster][namespace] = set
		}
	}
	return &auth.User{ID: 42, Perms: perms}
}

func decodeStatistics(t *testing.T, rr *httptest.ResponseRecorder, out any) {
	t.Helper()
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body)
	}
	if err := json.Unmarshal(rr.Body.Bytes(), out); err != nil {
		t.Fatal(err)
	}
}

func expectWarnings(t *testing.T, got []string, want ...string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("warnings = %v, want %v", got, want)
	}
}

func TestStatisticsWithoutPrometheus(t *testing.T) {
	home := statisticsKube(readyNode("n1", true, "4", "8Gi"), gamePod(scope.DefaultNamespace, "alpha-0", "n1"))
	router := statisticsRouter(clusterTestRegistry(home), nil)
	user := statisticsUser(map[string]map[string][]string{"local": {"*": {"cluster:read", "servers:read"}}})

	var live liveStatistics
	decodeStatistics(t, inventoryRequest(t, router, user, http.MethodGet, "/statistics/live"), &live)
	if live.Source != "none" || len(live.Warnings) != 0 || len(live.Nodes) != 1 || live.Cluster.Network != nil || len(live.Servers) != 0 {
		t.Fatalf("live = %+v", live)
	}
	if live.Nodes[0].Pods != 1 || live.Cluster.CPU.Capacity != 4 {
		t.Fatalf("live node = %+v", live.Nodes[0])
	}

	var history historyStatistics
	decodeStatistics(t, inventoryRequest(t, router, user, http.MethodGet, "/statistics/history"), &history)
	if history.Source != "none" || history.Network != nil || history.Heatmap != nil || len(history.Warnings) != 0 {
		t.Fatalf("history = %+v", history)
	}

	var node nodeStatistics
	decodeStatistics(t, inventoryRequest(t, router, user, http.MethodGet, "/statistics/nodes/n1"), &node)
	if node.Source != "none" || !node.Node.Ready || node.Node.Pods != 1 || node.CPU.Requested == nil || *node.CPU.Requested != 0.5 || node.Memory.Requested == nil || *node.Memory.Requested != 1<<30 {
		t.Fatalf("node = %+v", node)
	}

	var server serverStatistics
	decodeStatistics(t, inventoryRequest(t, router, user, http.MethodGet, "/servers/alpha/statistics"), &server)
	if server.Source != "none" || server.Pod != "alpha-0" || server.Node == nil || *server.Node != "n1" {
		t.Fatalf("server = %+v", server)
	}
	if server.CPU.Request == nil || *server.CPU.Request != 0.5 || server.CPU.Limit == nil || *server.CPU.Limit != 2 {
		t.Fatalf("server cpu = %+v", server.CPU)
	}
	if server.Memory.Request == nil || *server.Memory.Request != 1<<30 || server.Memory.Limit == nil || *server.Memory.Limit != 2<<30 {
		t.Fatalf("server memory = %+v", server.Memory)
	}
	if server.Health.Restarts == nil || *server.Health.Restarts != 3 {
		t.Fatalf("server health = %+v", server.Health)
	}
}

func TestStatisticsLiveWithPrometheus(t *testing.T) {
	home := statisticsKube(readyNode("n1", true, "4", "8Gi"), gamePod(scope.DefaultNamespace, "alpha-0", "n1"))
	prometheus := fakePrometheus(t,
		fakeSeries{"node_cpu_seconds_total", map[string]string{"nodename": "n1"}, "1.5"},
		fakeSeries{"node_network_receive_bytes_total", map[string]string{"nodename": "n1"}, "100"},
		fakeSeries{"node_network_transmit_bytes_total", map[string]string{"nodename": "n1"}, "50"},
		fakeSeries{"node_load1", map[string]string{"nodename": "n1"}, "0.25"},
		fakeSeries{"container_cpu_usage_seconds_total", map[string]string{"namespace": scope.DefaultNamespace, "pod": "alpha-0", "node": "n1"}, "0.5"},
		fakeSeries{"gameplane_agent_players_online", map[string]string{"namespace": scope.DefaultNamespace, "server": "alpha"}, "3"},
	)
	router := statisticsRouter(clusterTestRegistry(home), prometheus)

	visible := statisticsUser(map[string]map[string][]string{"local": {"*": {"cluster:read"}, scope.DefaultNamespace: {"servers:read"}}})
	var live liveStatistics
	decodeStatistics(t, inventoryRequest(t, router, visible, http.MethodGet, "/statistics/live"), &live)
	if live.Source != "prometheus" {
		t.Fatalf("source = %q", live.Source)
	}
	expectWarnings(t, live.Warnings)
	if live.Cluster.CPU.Used == nil || *live.Cluster.CPU.Used != 1.5 || live.Cluster.CPU.Capacity != 4 {
		t.Fatalf("cluster cpu = %+v", live.Cluster.CPU)
	}
	if live.Cluster.Network == nil || live.Cluster.Network.RX == nil || *live.Cluster.Network.RX != 100 {
		t.Fatalf("cluster network = %+v", live.Cluster.Network)
	}
	if len(live.Nodes) != 1 || live.Nodes[0].RX == nil || *live.Nodes[0].RX != 100 || live.Nodes[0].Load1 == nil || *live.Nodes[0].Load1 != 0.25 {
		t.Fatalf("nodes = %+v", live.Nodes)
	}
	if len(live.Servers) != 1 || live.Servers[0].Name != "alpha" || live.Servers[0].Players == nil || *live.Servers[0].Players != 3 || live.Servers[0].CPU == nil || *live.Servers[0].CPU != 0.5 {
		t.Fatalf("servers = %+v", live.Servers)
	}

	hidden := statisticsUser(map[string]map[string][]string{"local": {"*": {"cluster:read"}}})
	decodeStatistics(t, inventoryRequest(t, router, hidden, http.MethodGet, "/statistics/live"), &live)
	if len(live.Servers) != 0 {
		t.Fatalf("servers visible without servers:read: %+v", live.Servers)
	}
}

func TestStatisticsPrometheusDownFallsBack(t *testing.T) {
	home := statisticsKube(readyNode("n1", true, "4", "8Gi"))
	router := statisticsRouter(clusterTestRegistry(home), deadPrometheus(t))
	user := statisticsUser(map[string]map[string][]string{"local": {"*": {"cluster:read", "servers:read"}}})

	var live liveStatistics
	decodeStatistics(t, inventoryRequest(t, router, user, http.MethodGet, "/statistics/live"), &live)
	if live.Source != "none" || live.Cluster.Network != nil {
		t.Fatalf("live = %+v", live)
	}
	expectWarnings(t, live.Warnings, "prometheus_unreachable")

	var history historyStatistics
	decodeStatistics(t, inventoryRequest(t, router, user, http.MethodGet, "/statistics/history"), &history)
	if history.Source != "none" || history.Network != nil {
		t.Fatalf("history = %+v", history)
	}
	expectWarnings(t, history.Warnings, "prometheus_unreachable")

	var server serverStatistics
	decodeStatistics(t, inventoryRequest(t, router, user, http.MethodGet, "/servers/alpha/statistics"), &server)
	expectWarnings(t, server.Warnings, "prometheus_unreachable")
}

func TestStatisticsRejectsOtherCluster(t *testing.T) {
	reg := clusterTestRegistry(statisticsKube(readyNode("n1", true, "4", "8Gi")))
	reg.Set("other", fakeKubeClient())
	router := statisticsRouter(reg, nil)
	user := statisticsUser(map[string]map[string][]string{
		"local": {"*": {"cluster:read", "servers:read"}},
		"other": {"*": {"cluster:read", "servers:read"}},
	})
	for _, path := range []string{"/statistics/live", "/statistics/history", "/statistics/nodes/n1", "/servers/alpha/statistics"} {
		if rr := inventoryRequest(t, router, user, http.MethodGet, path+"?cluster=other"); rr.Code != http.StatusNotImplemented {
			t.Errorf("%s: status=%d body=%s", path, rr.Code, rr.Body)
		}
	}
}

func TestStatisticsLiveRequiresClusterRead(t *testing.T) {
	router := statisticsRouter(clusterTestRegistry(statisticsKube()), nil)
	user := statisticsUser(map[string]map[string][]string{"local": {"*": {"servers:read"}}})
	if rr := inventoryRequest(t, router, user, http.MethodGet, "/statistics/live"); rr.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body)
	}
}

func TestStatisticsRejectsUnknownAndInvalidNodes(t *testing.T) {
	router := statisticsRouter(clusterTestRegistry(statisticsKube(readyNode("n1", true, "4", "8Gi"))), nil)
	user := statisticsUser(map[string]map[string][]string{"local": {"*": {"cluster:read"}}})
	for _, path := range []string{"/statistics/nodes/missing", "/statistics/nodes/Bad_Name"} {
		if rr := inventoryRequest(t, router, user, http.MethodGet, path); rr.Code != http.StatusNotFound {
			t.Errorf("%s: status=%d body=%s", path, rr.Code, rr.Body)
		}
	}
}

func TestStatisticsRangeParsing(t *testing.T) {
	router := statisticsRouter(clusterTestRegistry(statisticsKube()), nil)
	user := statisticsUser(map[string]map[string][]string{"local": {"*": {"cluster:read"}}})
	for query, want := range map[string]historyStatistics{
		"?range=7d":    {Range: "7d", Step: 7200},
		"?range=bogus": {Range: "24h", Step: 900},
		"":             {Range: "24h", Step: 900},
	} {
		var history historyStatistics
		decodeStatistics(t, inventoryRequest(t, router, user, http.MethodGet, "/statistics/history"+query), &history)
		if history.Range != want.Range || history.Step != want.Step {
			t.Errorf("%q: range=%s step=%v, want %s %v", query, history.Range, history.Step, want.Range, want.Step)
		}
	}
}
