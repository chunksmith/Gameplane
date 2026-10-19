package handlers

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/GameplanePanel/gameplane/api/internal/auth"
	"github.com/GameplanePanel/gameplane/api/internal/httperr"
	"github.com/GameplanePanel/gameplane/api/internal/kube"
	"github.com/GameplanePanel/gameplane/api/internal/messages"
	"github.com/GameplanePanel/gameplane/api/internal/prom"
	"github.com/GameplanePanel/gameplane/api/internal/scope"
)

type rangeSpec struct {
	name string
	dur  time.Duration
	step time.Duration
}

var (
	nodeNameRE = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$`)
	rangeSpecs = map[string]rangeSpec{
		"15m": {name: "15m", dur: 15 * time.Minute, step: 15 * time.Second},
		"1h":  {name: "1h", dur: time.Hour, step: 30 * time.Second},
		"6h":  {name: "6h", dur: 6 * time.Hour, step: 3 * time.Minute},
		"24h": {name: "24h", dur: 24 * time.Hour, step: 15 * time.Minute},
		"7d":  {name: "7d", dur: 7 * 24 * time.Hour, step: 2 * time.Hour},
		"30d": {name: "30d", dur: 30 * 24 * time.Hour, step: 6 * time.Hour},
	}
	liveRange  = rangeSpec{name: "15m", dur: 15 * time.Minute, step: 30 * time.Second}
	liveWindow = rateWindow(liveRange.step)
)

const (
	physicalDevices = `device!~"lo|veth.*|cni.*|flannel.*|cali.*|vxlan.*|docker.*|br-.*|virbr.*|tailscale.*|tun.*|wg.*|kube-.*|cilium.*|lxc.*|genev.*"`
	filesystemTypes = `fstype!~"tmpfs|overlay|squashfs|nsfs|ramfs|fuse.*|autofs|devtmpfs"`
	nodeJoin        = ` * on(instance) group_left(nodename) node_uname_info`
	perNode         = "sum by (nodename)"
	clusterSum      = "sum"
	rxMetric        = "node_network_receive_bytes_total"
	txMetric        = "node_network_transmit_bytes_total"
	maxServerRows   = 50
	heatmapBuckets  = 24
	warnUnreachable = "prometheus_unreachable"
	warnPartial     = "prometheus_partial"
)

type statisticsHandler struct {
	reg  *kube.Registry
	prom *prom.Client
	now  func() time.Time
}

// MountStatistics wires the home-cluster statistics routes.
func MountStatistics(r chi.Router, reg *kube.Registry, p *prom.Client) {
	h := &statisticsHandler{reg: reg, prom: p, now: time.Now}
	r.Get("/statistics/live", h.live)
	r.Get("/statistics/history", h.history)
	r.Get("/statistics/nodes/{name}", h.node)
	r.Get("/servers/{name}/statistics", h.server)
}

func (h *statisticsHandler) home(w http.ResponseWriter, req *http.Request) (*clusterHandler, bool) {
	if rejectRemoteCluster(w, req) {
		return nil, false
	}
	k, ok := resolveCluster(w, req, h.reg)
	if !ok {
		return nil, false
	}
	if k == nil || k.Typed == nil {
		httperr.WriteCode(w, req, http.StatusServiceUnavailable, errors.New("selected cluster client unavailable"))
		return nil, false
	}
	return &clusterHandler{reg: h.reg, k: k, clusterID: scope.DefaultCluster}, true
}

func parseRange(req *http.Request) rangeSpec {
	spec, ok := rangeSpecs[req.URL.Query().Get("range")]
	if !ok {
		return rangeSpecs["24h"]
	}
	return spec
}

func rateWindow(step time.Duration) string {
	return promDuration(max(step, time.Minute))
}

func promDuration(d time.Duration) string {
	return strconv.FormatInt(int64(d/time.Second), 10) + "s"
}

func cpuExpr(agg, window, join string) string {
	return fmt.Sprintf(`%s (1 - rate(node_cpu_seconds_total{mode="idle"}[%s])%s)`, agg, window, join)
}

func memoryExpr(agg, join string) string {
	return fmt.Sprintf(`%s ((node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)%s)`, agg, join)
}

func networkExpr(agg, metric, window, join string) string {
	return fmt.Sprintf(`%s (rate(%s{%s}[%s])%s)`, agg, metric, physicalDevices, window, join)
}

func increaseExpr(metric, window, join string) string {
	return fmt.Sprintf(`sum (increase(%s{%s}[%s])%s)`, metric, physicalDevices, window, join)
}

func nodeTrafficExpr(window string) string {
	return networkExpr(perNode, rxMetric, window, nodeJoin) + " + " + networkExpr(perNode, txMetric, window, nodeJoin)
}

func loadExpr(metric, join string) string {
	return fmt.Sprintf(`max by (nodename) (%s%s)`, metric, join)
}

func diskExpr(metric, window, join string) string {
	return fmt.Sprintf(`sum by (nodename) (rate(%s[%s])%s)`, metric, window, join)
}

func bootExpr(join string) string {
	return fmt.Sprintf(`max by (nodename) (node_boot_time_seconds%s)`, join)
}

func deviceExpr(function, metric, window, join string) string {
	return fmt.Sprintf(`sum by (device) (%s(%s{device!~"lo|veth.*"}[%s])%s)`, function, metric, window, join)
}

func nodeJoinFor(node string) string {
	return fmt.Sprintf(` * on(instance) group_left(nodename) node_uname_info{nodename=%s}`, prom.Quote(node))
}

func podMatch(namespace, pod string) string {
	return fmt.Sprintf(`namespace=%s,pod=%s`, prom.Quote(namespace), prom.Quote(pod))
}

func serverMatch(namespace, server string) string {
	return fmt.Sprintf(`namespace=%s,server=%s`, prom.Quote(namespace), prom.Quote(server))
}

type promRun struct {
	ctx        context.Context
	client     *prom.Client
	at         time.Time
	wg         sync.WaitGroup
	total      int
	failed     atomic.Int32
	connection atomic.Bool
}

func newPromRun(ctx context.Context, client *prom.Client, at time.Time) *promRun {
	return &promRun{ctx: ctx, client: client, at: at}
}

func (r *promRun) instant(dest *[]prom.Sample, expr string) {
	if r.client == nil {
		return
	}
	r.spawn(func() error {
		samples, err := r.client.Query(r.ctx, expr, r.at)
		*dest = samples
		return err
	})
}

func (r *promRun) series(dest *[]prom.Series, expr string, start, end time.Time, step time.Duration) {
	if r.client == nil {
		return
	}
	r.spawn(func() error {
		result, err := r.client.QueryRange(r.ctx, expr, start, end, step)
		*dest = result
		return err
	})
}

func (r *promRun) spawn(query func() error) {
	r.total++
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		err := query()
		if err == nil {
			return
		}
		slog.Debug("prometheus query failed", "err", err)
		r.failed.Add(1)
		var urlErr *url.Error
		if errors.As(err, &urlErr) && !urlErr.Timeout() {
			r.connection.Store(true)
		}
	}()
}

func (r *promRun) wait() (unreachable, partial bool) {
	r.wg.Wait()
	failed := int(r.failed.Load())
	unreachable = r.total > 0 && (failed == r.total || r.connection.Load())
	return unreachable, !unreachable && failed > 0
}

func warningsFor(unreachable, partial bool) []string {
	switch {
	case unreachable:
		return []string{warnUnreachable}
	case partial:
		return []string{warnPartial}
	default:
		return []string{}
	}
}

func firstPoints(series []prom.Series) []prom.Point {
	if len(series) == 0 {
		return []prom.Point{}
	}
	return series[0].Points
}

func firstValue(samples []prom.Sample) *float64 {
	if len(samples) == 0 {
		return nil
	}
	return &samples[0].Value
}

func byLabel(samples []prom.Sample, label string) map[string]float64 {
	values := make(map[string]float64, len(samples))
	for _, sample := range samples {
		values[sample.Labels[label]] = sample.Value
	}
	return values
}

func indexSamples(samples []prom.Sample, labels ...string) map[string]prom.Sample {
	indexed := make(map[string]prom.Sample, len(samples))
	for _, sample := range samples {
		keys := make([]string, 0, len(labels))
		for _, label := range labels {
			keys = append(keys, sample.Labels[label])
		}
		indexed[strings.Join(keys, "/")] = sample
	}
	return indexed
}

func valueOfSample(samples map[string]prom.Sample, key string) *float64 {
	sample, ok := samples[key]
	if !ok {
		return nil
	}
	return &sample.Value
}

func valueAt(values map[string]float64, key string) *float64 {
	value, ok := values[key]
	if !ok {
		return nil
	}
	return &value
}

func seriesByNode(series []prom.Series) map[string][]prom.Point {
	points := make(map[string][]prom.Point, len(series))
	for _, item := range series {
		points[item.Labels["nodename"]] = item.Points
	}
	return points
}

func percentPoints(points []prom.Point, capacity float64) []prom.Point {
	percent := make([]prom.Point, 0, len(points))
	if capacity <= 0 {
		return percent
	}
	for _, point := range points {
		percent = append(percent, prom.Point{point[0], min(max(point[1]/capacity*100, 0), 100)})
	}
	return percent
}

func bucketize(points []prom.Point, start, step float64) []*float64 {
	buckets := make([]*float64, heatmapBuckets)
	for _, point := range points {
		index := int(math.Round((point[0] - start) / step))
		if index >= 0 && index < heatmapBuckets {
			value := point[1]
			buckets[index] = &value
		}
	}
	return buckets
}

type peakValue struct {
	Value float64 `json:"value"`
	At    float64 `json:"at"`
}

func trafficSummary(rx, tx []prom.Point) (*peakValue, *float64) {
	txAt := make(map[float64]float64, len(tx))
	for _, point := range tx {
		txAt[point[0]] = point[1]
	}
	var peak *peakValue
	totals := make([]float64, 0, len(rx))
	for _, point := range rx {
		transmit, ok := txAt[point[0]]
		if !ok {
			continue
		}
		total := point[1] + transmit
		totals = append(totals, total)
		if peak == nil || total > peak.Value {
			peak = &peakValue{Value: total, At: point[0]}
		}
	}
	if len(totals) == 0 {
		return nil, nil
	}
	slices.Sort(totals)
	p95 := totals[int(math.Ceil(0.95*float64(len(totals))))-1]
	return peak, &p95
}

type statisticsNode struct {
	Name           string   `json:"name"`
	Ready          bool     `json:"ready"`
	InternalIP     string   `json:"internalIP,omitempty"`
	CPUCapacity    float64  `json:"cpuCapacity"`
	MemoryCapacity float64  `json:"memoryCapacity"`
	Pods           int      `json:"pods"`
	CPUUsed        *float64 `json:"cpuUsed"`
	MemoryUsed     *float64 `json:"memoryUsed"`
	RX             *float64 `json:"rx"`
	TX             *float64 `json:"tx"`
	Load1          *float64 `json:"load1"`
}

type nodeValues struct {
	cpu, memory, rx, tx, load1 map[string]float64
}

func usageValues(usage map[string]nodeUsage) nodeValues {
	values := nodeValues{cpu: map[string]float64{}, memory: map[string]float64{}}
	for name, measured := range usage {
		values.cpu[name] = measured.cpuCores
		values.memory[name] = measured.memoryBytes
	}
	return values
}

func quantityFloat(list corev1.ResourceList, name corev1.ResourceName) float64 {
	quantity := list[name]
	return quantity.AsApproximateFloat64()
}

func optionalQuantity(list corev1.ResourceList, name corev1.ResourceName) *float64 {
	if _, ok := list[name]; !ok {
		return nil
	}
	value := quantityFloat(list, name)
	return &value
}

func summarizeNode(item *corev1.Node, pods map[string]int64, values nodeValues) statisticsNode {
	node := statisticsNode{
		Name:           item.Name,
		Ready:          mapNode(item).Status == "Ready",
		CPUCapacity:    quantityFloat(item.Status.Capacity, corev1.ResourceCPU),
		MemoryCapacity: quantityFloat(item.Status.Capacity, corev1.ResourceMemory),
		Pods:           int(pods[item.Name]),
		CPUUsed:        valueAt(values.cpu, item.Name),
		MemoryUsed:     valueAt(values.memory, item.Name),
		RX:             valueAt(values.rx, item.Name),
		TX:             valueAt(values.tx, item.Name),
		Load1:          valueAt(values.load1, item.Name),
	}
	for _, address := range item.Status.Addresses {
		if address.Type == corev1.NodeInternalIP {
			node.InternalIP = address.Address
			break
		}
	}
	return node
}

func summarizeNodes(items []corev1.Node, pods map[string]int64, values nodeValues) []statisticsNode {
	nodes := make([]statisticsNode, 0, len(items))
	for i := range items {
		nodes = append(nodes, summarizeNode(&items[i], pods, values))
	}
	slices.SortFunc(nodes, func(a, b statisticsNode) int { return strings.Compare(a.Name, b.Name) })
	return nodes
}

func sumOf(nodes []statisticsNode, field func(statisticsNode) *float64) *float64 {
	var total float64
	found := false
	for _, node := range nodes {
		if value := field(node); value != nil {
			total += *value
			found = true
		}
	}
	if !found {
		return nil
	}
	return &total
}

type nodeSamples struct {
	cpu, memory, rx, tx, load1 []prom.Sample
}

func queueNodeSamples(run *promRun, samples *nodeSamples, agg, window, join string) {
	run.instant(&samples.cpu, cpuExpr(agg, window, join))
	run.instant(&samples.memory, memoryExpr(agg, join))
	run.instant(&samples.rx, networkExpr(agg, rxMetric, window, join))
	run.instant(&samples.tx, networkExpr(agg, txMetric, window, join))
	run.instant(&samples.load1, loadExpr("node_load1", join))
}

func (s *nodeSamples) values() nodeValues {
	return nodeValues{
		cpu:    byLabel(s.cpu, "nodename"),
		memory: byLabel(s.memory, "nodename"),
		rx:     byLabel(s.rx, "nodename"),
		tx:     byLabel(s.tx, "nodename"),
		load1:  byLabel(s.load1, "nodename"),
	}
}

type serverSamples struct {
	cpu, memory, rx, tx, online, playersMax, cpuLimit, memoryLimit []prom.Sample
}

func queueServers(run *promRun, samples *serverSamples, window string) {
	run.instant(&samples.cpu, fmt.Sprintf(`sum by (namespace, pod, node) (rate(container_cpu_usage_seconds_total{container="game"}[%s]))`, window))
	run.instant(&samples.memory, `sum by (namespace, pod) (container_memory_working_set_bytes{container="game"})`)
	run.instant(&samples.rx, fmt.Sprintf(`sum by (namespace, pod) (rate(container_network_receive_bytes_total{interface="eth0"}[%s]))`, window))
	run.instant(&samples.tx, fmt.Sprintf(`sum by (namespace, pod) (rate(container_network_transmit_bytes_total{interface="eth0"}[%s]))`, window))
	run.instant(&samples.online, `max by (namespace, server) (gameplane_agent_players_online)`)
	run.instant(&samples.playersMax, `max by (namespace, server) (gameplane_agent_players_max)`)
	run.instant(&samples.cpuLimit, `max by (namespace, server) (gameplane_agent_cpu_limit_millicores) / 1000`)
	run.instant(&samples.memoryLimit, `max by (namespace, server) (gameplane_agent_memory_limit_bytes)`)
}

func (s *serverSamples) rows() []statisticsServer {
	cpu := indexSamples(s.cpu, "namespace", "pod")
	memory := indexSamples(s.memory, "namespace", "pod")
	rx := indexSamples(s.rx, "namespace", "pod")
	tx := indexSamples(s.tx, "namespace", "pod")
	online := indexSamples(s.online, "namespace", "server")
	playersMax := indexSamples(s.playersMax, "namespace", "server")
	cpuLimit := indexSamples(s.cpuLimit, "namespace", "server")
	memoryLimit := indexSamples(s.memoryLimit, "namespace", "server")

	names := map[string]statisticsServer{}
	add := func(namespace, name string) {
		key := namespace + "/" + name
		if _, ok := names[key]; !ok {
			names[key] = statisticsServer{Name: name, Namespace: namespace}
		}
	}
	for _, sample := range s.online {
		add(sample.Labels["namespace"], sample.Labels["server"])
	}
	for _, sample := range s.cpu {
		if name, ok := strings.CutSuffix(sample.Labels["pod"], "-0"); ok {
			add(sample.Labels["namespace"], name)
		}
	}

	rows := make([]statisticsServer, 0, len(names))
	for _, row := range names {
		podKey := row.Namespace + "/" + row.Name + "-0"
		serverKey := row.Namespace + "/" + row.Name
		row.CPU = valueOfSample(cpu, podKey)
		row.Memory = valueOfSample(memory, podKey)
		row.RX = valueOfSample(rx, podKey)
		row.TX = valueOfSample(tx, podKey)
		row.Players = valueOfSample(online, serverKey)
		row.MaxPlayers = valueOfSample(playersMax, serverKey)
		row.CPULimit = valueOfSample(cpuLimit, serverKey)
		row.MemoryLimit = valueOfSample(memoryLimit, serverKey)
		if sample, ok := cpu[podKey]; ok && sample.Labels["node"] != "" {
			node := sample.Labels["node"]
			row.Node = &node
		}
		rows = append(rows, row)
	}
	slices.SortFunc(rows, func(a, b statisticsServer) int {
		if order := cmp.Compare(valueOrZero(b.CPU), valueOrZero(a.CPU)); order != 0 {
			return order
		}
		return strings.Compare(a.Namespace+"/"+a.Name, b.Namespace+"/"+b.Name)
	})
	return rows
}

func valueOrZero(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}

type statisticsServer struct {
	Name        string   `json:"name"`
	Namespace   string   `json:"namespace"`
	Node        *string  `json:"node"`
	CPU         *float64 `json:"cpu"`
	CPULimit    *float64 `json:"cpuLimit"`
	Memory      *float64 `json:"memory"`
	MemoryLimit *float64 `json:"memoryLimit"`
	RX          *float64 `json:"rx"`
	TX          *float64 `json:"tx"`
	Players     *float64 `json:"players"`
	MaxPlayers  *float64 `json:"maxPlayers"`
}

func visibleServers(req *http.Request, rows []statisticsServer) []statisticsServer {
	user := auth.UserFromContext(req.Context())
	visible := make([]statisticsServer, 0, len(rows))
	for _, row := range rows {
		if user.Can("servers:read", true, scope.DefaultCluster, row.Namespace) {
			visible = append(visible, row)
		}
	}
	return visible
}

type liveData struct {
	cpu, memory, rx, tx []prom.Series
	nodes               nodeSamples
	servers             serverSamples
}

type capacityUsage struct {
	Used     *float64     `json:"used"`
	Capacity float64      `json:"capacity"`
	Series   []prom.Point `json:"series"`
}

type networkLive struct {
	RX       *float64     `json:"rx"`
	TX       *float64     `json:"tx"`
	RXSeries []prom.Point `json:"rxSeries"`
	TXSeries []prom.Point `json:"txSeries"`
}

type clusterLive struct {
	CPU     capacityUsage `json:"cpu"`
	Memory  capacityUsage `json:"memory"`
	Network *networkLive  `json:"network"`
}

type liveStatistics struct {
	Source      string             `json:"source"`
	Warnings    []string           `json:"warnings"`
	GeneratedAt string             `json:"generatedAt"`
	Cluster     clusterLive        `json:"cluster"`
	Nodes       []statisticsNode   `json:"nodes"`
	Servers     []statisticsServer `json:"servers"`
}

func (h *statisticsHandler) live(w http.ResponseWriter, req *http.Request) {
	home, ok := h.home(w, req)
	if !ok {
		return
	}
	ctx := req.Context()
	items, err := home.k.Typed.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	now := h.now()
	liveStart := now.Add(-liveRange.dur)
	var data liveData
	run := newPromRun(ctx, h.prom, now)
	run.series(&data.cpu, cpuExpr(clusterSum, liveWindow, nodeJoin), liveStart, now, liveRange.step)
	run.series(&data.memory, memoryExpr(clusterSum, nodeJoin), liveStart, now, liveRange.step)
	run.series(&data.rx, networkExpr(clusterSum, rxMetric, liveWindow, nodeJoin), liveStart, now, liveRange.step)
	run.series(&data.tx, networkExpr(clusterSum, txMetric, liveWindow, nodeJoin), liveStart, now, liveRange.step)
	queueNodeSamples(run, &data.nodes, perNode, liveWindow, nodeJoin)
	queueServers(run, &data.servers, liveWindow)
	unreachable, partial := run.wait()
	prometheus := h.prom != nil && !unreachable
	if !prometheus {
		data = liveData{}
	}

	pods := home.countNodePods(ctx)
	source, values := "none", usageValues(nil)
	if prometheus {
		source, values = "prometheus", data.nodes.values()
	} else if usage := home.fetchNodeUsage(ctx); usage != nil {
		source, values = "metrics-server", usageValues(usage)
	}
	nodes := summarizeNodes(items.Items, pods, values)
	var cpuCapacity, memoryCapacity float64
	for _, node := range nodes {
		cpuCapacity += node.CPUCapacity
		memoryCapacity += node.MemoryCapacity
	}
	cluster := clusterLive{
		CPU: capacityUsage{
			Used:     sumOf(nodes, func(node statisticsNode) *float64 { return node.CPUUsed }),
			Capacity: cpuCapacity,
			Series:   firstPoints(data.cpu),
		},
		Memory: capacityUsage{
			Used:     sumOf(nodes, func(node statisticsNode) *float64 { return node.MemoryUsed }),
			Capacity: memoryCapacity,
			Series:   firstPoints(data.memory),
		},
	}
	if prometheus {
		cluster.Network = &networkLive{
			RX:       sumOf(nodes, func(node statisticsNode) *float64 { return node.RX }),
			TX:       sumOf(nodes, func(node statisticsNode) *float64 { return node.TX }),
			RXSeries: firstPoints(data.rx),
			TXSeries: firstPoints(data.tx),
		}
	}
	servers := visibleServers(req, data.servers.rows())
	if len(servers) > maxServerRows {
		servers = servers[:maxServerRows]
	}
	writeJSON(w, liveStatistics{
		Source:      source,
		Warnings:    warningsFor(unreachable, partial),
		GeneratedAt: now.UTC().Format(time.RFC3339),
		Cluster:     cluster,
		Nodes:       nodes,
		Servers:     servers,
	})
}

type historyData struct {
	rx, tx                                    []prom.Series
	rxTotal, txTotal                          []prom.Sample
	cpuBuckets, memoryBuckets, networkBuckets []prom.Series
	nodeCPU                                   []prom.Series
}

type networkHistory struct {
	RX      []prom.Point `json:"rx"`
	TX      []prom.Point `json:"tx"`
	RXTotal *float64     `json:"rxTotal"`
	TXTotal *float64     `json:"txTotal"`
	Peak    *peakValue   `json:"peak"`
	P95     *float64     `json:"p95"`
}

type heatmap struct {
	Buckets []float64             `json:"buckets"`
	CPU     map[string][]*float64 `json:"cpu"`
	Memory  map[string][]*float64 `json:"memory"`
	Network map[string][]*float64 `json:"network"`
}

type historyStatistics struct {
	Source   string                  `json:"source"`
	Warnings []string                `json:"warnings"`
	Range    string                  `json:"range"`
	Step     float64                 `json:"step"`
	Start    int64                   `json:"start"`
	End      int64                   `json:"end"`
	Network  *networkHistory         `json:"network"`
	Heatmap  *heatmap                `json:"heatmap"`
	NodeCPU  map[string][]prom.Point `json:"nodeCpu"`
}

func queueHistory(run *promRun, data *historyData, spec rangeSpec, now time.Time) {
	window := rateWindow(spec.step)
	start := now.Add(-spec.dur)
	bucket := spec.dur / heatmapBuckets
	bucketWindow := rateWindow(bucket)
	bucketStart := now.Add(bucket - spec.dur)
	bucketEnd := now.Add(bucket / 2)
	run.series(&data.rx, networkExpr(clusterSum, rxMetric, window, nodeJoin), start, now, spec.step)
	run.series(&data.tx, networkExpr(clusterSum, txMetric, window, nodeJoin), start, now, spec.step)
	run.instant(&data.rxTotal, increaseExpr(rxMetric, promDuration(spec.dur), nodeJoin))
	run.instant(&data.txTotal, increaseExpr(txMetric, promDuration(spec.dur), nodeJoin))
	run.series(&data.cpuBuckets, cpuExpr(perNode, bucketWindow, nodeJoin), bucketStart, bucketEnd, bucket)
	run.series(&data.memoryBuckets, memoryExpr(perNode, nodeJoin), bucketStart, bucketEnd, bucket)
	run.series(&data.networkBuckets, nodeTrafficExpr(bucketWindow), bucketStart, bucketEnd, bucket)
	run.series(&data.nodeCPU, cpuExpr(perNode, window, nodeJoin), start, now, spec.step)
}

func heatmapOf(nodes []statisticsNode, data historyData, start, step float64) *heatmap {
	cpu := seriesByNode(data.cpuBuckets)
	memory := seriesByNode(data.memoryBuckets)
	network := seriesByNode(data.networkBuckets)
	result := &heatmap{
		Buckets: make([]float64, heatmapBuckets),
		CPU:     map[string][]*float64{},
		Memory:  map[string][]*float64{},
		Network: map[string][]*float64{},
	}
	for i := range result.Buckets {
		result.Buckets[i] = start + float64(i)*step
	}
	for _, node := range nodes {
		result.CPU[node.Name] = bucketize(percentPoints(cpu[node.Name], node.CPUCapacity), start, step)
		result.Memory[node.Name] = bucketize(percentPoints(memory[node.Name], node.MemoryCapacity), start, step)
		result.Network[node.Name] = bucketize(network[node.Name], start, step)
	}
	return result
}

func (h *statisticsHandler) history(w http.ResponseWriter, req *http.Request) {
	home, ok := h.home(w, req)
	if !ok {
		return
	}
	ctx := req.Context()
	items, err := home.k.Typed.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	spec := parseRange(req)
	now := h.now()
	var data historyData
	run := newPromRun(ctx, h.prom, now)
	queueHistory(run, &data, spec, now)
	unreachable, partial := run.wait()
	prometheus := h.prom != nil && !unreachable
	if !prometheus {
		data = historyData{}
	}

	nodes := summarizeNodes(items.Items, nil, nodeValues{})
	nodeCPU := seriesByNode(data.nodeCPU)
	response := historyStatistics{
		Source:   "none",
		Warnings: warningsFor(unreachable, partial),
		Range:    spec.name,
		Step:     spec.step.Seconds(),
		Start:    now.Add(-spec.dur).Unix(),
		End:      now.Unix(),
		NodeCPU:  map[string][]prom.Point{},
	}
	for _, node := range nodes {
		response.NodeCPU[node.Name] = percentPoints(nodeCPU[node.Name], node.CPUCapacity)
	}
	if prometheus {
		response.Source = "prometheus"
		rx, tx := firstPoints(data.rx), firstPoints(data.tx)
		peak, p95 := trafficSummary(rx, tx)
		response.Network = &networkHistory{
			RX:      rx,
			TX:      tx,
			RXTotal: firstValue(data.rxTotal),
			TXTotal: firstValue(data.txTotal),
			Peak:    peak,
			P95:     p95,
		}
		bucketStart := float64(now.Add(spec.dur/heatmapBuckets-spec.dur).UnixMilli()) / 1000
		response.Heatmap = heatmapOf(nodes, data, bucketStart, (spec.dur / heatmapBuckets).Seconds())
	}
	writeJSON(w, response)
}

type nodeData struct {
	samples                                  nodeSamples
	load5, load15, diskRead, diskWrite, boot []prom.Sample
	liveCPU, liveMemory, liveRX, liveTX      []prom.Series
	cpu, memory, rx, tx                      []prom.Series
	interfaces                               interfaceData
	fsSize, fsAvail                          []prom.Sample
	servers                                  serverSamples
}

type interfaceData struct {
	rxRate, txRate, rxPackets, txPackets, rxTotal, txTotal, errorCount, dropCount []prom.Sample
}

func queueInterfaces(run *promRun, data *interfaceData, window, duration, join string) {
	run.instant(&data.rxRate, deviceExpr("rate", rxMetric, window, join))
	run.instant(&data.txRate, deviceExpr("rate", txMetric, window, join))
	run.instant(&data.rxPackets, deviceExpr("rate", "node_network_receive_packets_total", window, join))
	run.instant(&data.txPackets, deviceExpr("rate", "node_network_transmit_packets_total", window, join))
	run.instant(&data.rxTotal, deviceExpr("increase", rxMetric, duration, join))
	run.instant(&data.txTotal, deviceExpr("increase", txMetric, duration, join))
	run.instant(&data.errorCount, deviceExpr("increase", "node_network_receive_errs_total", duration, join)+" + "+deviceExpr("increase", "node_network_transmit_errs_total", duration, join))
	run.instant(&data.dropCount, deviceExpr("increase", "node_network_receive_drop_total", duration, join)+" + "+deviceExpr("increase", "node_network_transmit_drop_total", duration, join))
}

type nodeInterface struct {
	Name      string   `json:"name"`
	RX        *float64 `json:"rx"`
	TX        *float64 `json:"tx"`
	RXPackets *float64 `json:"rxPackets"`
	TXPackets *float64 `json:"txPackets"`
	RXTotal   *float64 `json:"rxTotal"`
	TXTotal   *float64 `json:"txTotal"`
	Errors    *float64 `json:"errors"`
	Drops     *float64 `json:"drops"`
}

func interfacesOf(data interfaceData) []nodeInterface {
	rxRate := byLabel(data.rxRate, "device")
	txRate := byLabel(data.txRate, "device")
	rxPackets := byLabel(data.rxPackets, "device")
	txPackets := byLabel(data.txPackets, "device")
	rxTotal := byLabel(data.rxTotal, "device")
	txTotal := byLabel(data.txTotal, "device")
	errorCount := byLabel(data.errorCount, "device")
	dropCount := byLabel(data.dropCount, "device")

	names := map[string]struct{}{}
	for _, column := range []map[string]float64{rxRate, txRate, rxPackets, txPackets, rxTotal, txTotal, errorCount, dropCount} {
		for name := range column {
			names[name] = struct{}{}
		}
	}
	out := make([]nodeInterface, 0, len(names))
	for _, device := range slices.Sorted(maps.Keys(names)) {
		out = append(out, nodeInterface{
			Name:      device,
			RX:        valueAt(rxRate, device),
			TX:        valueAt(txRate, device),
			RXPackets: valueAt(rxPackets, device),
			TXPackets: valueAt(txPackets, device),
			RXTotal:   valueAt(rxTotal, device),
			TXTotal:   valueAt(txTotal, device),
			Errors:    valueAt(errorCount, device),
			Drops:     valueAt(dropCount, device),
		})
	}
	return out
}

type filesystem struct {
	Mountpoint string  `json:"mountpoint"`
	Device     string  `json:"device"`
	Fstype     string  `json:"fstype"`
	Size       float64 `json:"size"`
	Used       float64 `json:"used"`
}

func filesystemsOf(size, available []prom.Sample) []filesystem {
	free := make(map[string]float64, len(available))
	for _, sample := range available {
		free[fsKey(sample)] = sample.Value
	}
	out := make([]filesystem, 0, len(size))
	for _, sample := range size {
		if avail, ok := free[fsKey(sample)]; ok {
			out = append(out, filesystem{
				Mountpoint: sample.Labels["mountpoint"],
				Device:     sample.Labels["device"],
				Fstype:     sample.Labels["fstype"],
				Size:       sample.Value,
				Used:       sample.Value - avail,
			})
		}
	}
	slices.SortFunc(out, func(a, b filesystem) int { return strings.Compare(a.Mountpoint, b.Mountpoint) })
	return out
}

func fsKey(sample prom.Sample) string {
	return strings.Join([]string{sample.Labels["mountpoint"], sample.Labels["device"], sample.Labels["fstype"]}, "\x00")
}

func queueNode(run *promRun, data *nodeData, name string, spec rangeSpec, now time.Time) {
	join := nodeJoinFor(name)
	window := rateWindow(spec.step)
	liveStart := now.Add(-liveRange.dur)
	start := now.Add(-spec.dur)
	queueNodeSamples(run, &data.samples, perNode, liveWindow, join)
	run.instant(&data.load5, loadExpr("node_load5", join))
	run.instant(&data.load15, loadExpr("node_load15", join))
	run.instant(&data.diskRead, diskExpr("node_disk_read_bytes_total", liveWindow, join))
	run.instant(&data.diskWrite, diskExpr("node_disk_written_bytes_total", liveWindow, join))
	run.instant(&data.boot, bootExpr(join))
	run.series(&data.liveCPU, cpuExpr(perNode, liveWindow, join), liveStart, now, liveRange.step)
	run.series(&data.liveMemory, memoryExpr(perNode, join), liveStart, now, liveRange.step)
	run.series(&data.liveRX, networkExpr(perNode, rxMetric, liveWindow, join), liveStart, now, liveRange.step)
	run.series(&data.liveTX, networkExpr(perNode, txMetric, liveWindow, join), liveStart, now, liveRange.step)
	run.series(&data.cpu, cpuExpr(perNode, window, join), start, now, spec.step)
	run.series(&data.memory, memoryExpr(perNode, join), start, now, spec.step)
	run.series(&data.rx, networkExpr(perNode, rxMetric, window, join), start, now, spec.step)
	run.series(&data.tx, networkExpr(perNode, txMetric, window, join), start, now, spec.step)
	queueInterfaces(run, &data.interfaces, liveWindow, promDuration(spec.dur), join)
	run.instant(&data.fsSize, "node_filesystem_size_bytes{"+filesystemTypes+"}"+join)
	run.instant(&data.fsAvail, "node_filesystem_avail_bytes{"+filesystemTypes+"}"+join)
	queueServers(run, &data.servers, liveWindow)
}

type nodeDetail struct {
	statisticsNode
	OSImage        string   `json:"osImage,omitempty"`
	KernelVersion  string   `json:"kernelVersion,omitempty"`
	KubeletVersion string   `json:"kubeletVersion,omitempty"`
	BootTime       *float64 `json:"bootTime"`
}

type nodeLive struct {
	Load5        *float64     `json:"load5"`
	Load15       *float64     `json:"load15"`
	DiskRead     *float64     `json:"diskRead"`
	DiskWrite    *float64     `json:"diskWrite"`
	CPUSeries    []prom.Point `json:"cpuSeries"`
	MemorySeries []prom.Point `json:"memorySeries"`
	RXSeries     []prom.Point `json:"rxSeries"`
	TXSeries     []prom.Point `json:"txSeries"`
}

type nodeUsageSeries struct {
	Usage     []prom.Point `json:"usage"`
	Requested *float64     `json:"requested"`
}

type nodeTraffic struct {
	RX []prom.Point `json:"rx"`
	TX []prom.Point `json:"tx"`
}

type nodeStatistics struct {
	Source      string             `json:"source"`
	Warnings    []string           `json:"warnings"`
	Range       string             `json:"range"`
	Step        float64            `json:"step"`
	Node        nodeDetail         `json:"node"`
	Live        nodeLive           `json:"live"`
	CPU         nodeUsageSeries    `json:"cpu"`
	Memory      nodeUsageSeries    `json:"memory"`
	Network     nodeTraffic        `json:"network"`
	Interfaces  []nodeInterface    `json:"interfaces"`
	Filesystems []filesystem       `json:"filesystems"`
	Servers     []statisticsServer `json:"servers"`
}

func nodeServers(req *http.Request, samples *serverSamples, name string) []statisticsServer {
	servers := []statisticsServer{}
	for _, row := range visibleServers(req, samples.rows()) {
		if row.Node != nil && *row.Node == name {
			servers = append(servers, row)
		}
	}
	return servers
}

func (h *statisticsHandler) node(w http.ResponseWriter, req *http.Request) {
	home, ok := h.home(w, req)
	if !ok {
		return
	}
	name := chi.URLParam(req, "name")
	if !nodeNameRE.MatchString(name) {
		httperr.WriteMessage(w, req, messages.New(httperr.IDNotFound, nil))
		return
	}
	ctx := req.Context()
	item, err := home.k.Typed.CoreV1().Nodes().Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		httperr.WriteMessage(w, req, messages.New(httperr.IDNotFound, nil))
		return
	}
	if err != nil {
		httperr.Write(w, req, err)
		return
	}
	spec := parseRange(req)
	now := h.now()
	var data nodeData
	run := newPromRun(ctx, h.prom, now)
	queueNode(run, &data, name, spec, now)
	unreachable, partial := run.wait()
	prometheus := h.prom != nil && !unreachable
	if !prometheus {
		data = nodeData{}
	}

	pods := home.countNodePods(ctx)
	source, values := "none", usageValues(nil)
	if prometheus {
		source, values = "prometheus", data.samples.values()
	} else if usage := home.fetchNodeUsage(ctx); usage != nil {
		source, values = "metrics-server", usageValues(usage)
	}
	var cpuRequested, memoryRequested *float64
	if allocation := home.fetchNodeAllocation(ctx); allocation != nil {
		reserved := allocation[name]
		cpuRequested, memoryRequested = &reserved.cpuRequests, &reserved.memoryRequests
	}
	writeJSON(w, nodeStatistics{
		Source:   source,
		Warnings: warningsFor(unreachable, partial),
		Range:    spec.name,
		Step:     spec.step.Seconds(),
		Node: nodeDetail{
			statisticsNode: summarizeNode(item, pods, values),
			OSImage:        item.Status.NodeInfo.OSImage,
			KernelVersion:  item.Status.NodeInfo.KernelVersion,
			KubeletVersion: item.Status.NodeInfo.KubeletVersion,
			BootTime:       firstValue(data.boot),
		},
		Live: nodeLive{
			Load5:        firstValue(data.load5),
			Load15:       firstValue(data.load15),
			DiskRead:     firstValue(data.diskRead),
			DiskWrite:    firstValue(data.diskWrite),
			CPUSeries:    firstPoints(data.liveCPU),
			MemorySeries: firstPoints(data.liveMemory),
			RXSeries:     firstPoints(data.liveRX),
			TXSeries:     firstPoints(data.liveTX),
		},
		CPU:         nodeUsageSeries{Usage: firstPoints(data.cpu), Requested: cpuRequested},
		Memory:      nodeUsageSeries{Usage: firstPoints(data.memory), Requested: memoryRequested},
		Network:     nodeTraffic{RX: firstPoints(data.rx), TX: firstPoints(data.tx)},
		Interfaces:  interfacesOf(data.interfaces),
		Filesystems: filesystemsOf(data.fsSize, data.fsAvail),
		Servers:     nodeServers(req, &data.servers, name),
	})
}

type playersSeries struct {
	Online []prom.Point `json:"online"`
	Max    *float64     `json:"max"`
}

type resourceUsage struct {
	Usage   []prom.Point `json:"usage"`
	Request *float64     `json:"request"`
	Limit   *float64     `json:"limit"`
}

type serverNetwork struct {
	RX           []prom.Point `json:"rx"`
	TX           []prom.Point `json:"tx"`
	RXSinceStart *float64     `json:"rxSinceStart"`
	TXSinceStart *float64     `json:"txSinceStart"`
	Peak         *peakValue   `json:"peak"`
	P95          *float64     `json:"p95"`
	RXPackets    *float64     `json:"rxPackets"`
	TXPackets    *float64     `json:"txPackets"`
}

type serverDisk struct {
	Used   *float64 `json:"used"`
	Total  *float64 `json:"total"`
	Growth *float64 `json:"growth"`
	Read   *float64 `json:"read"`
	Write  *float64 `json:"write"`
}

type serverHealth struct {
	Restarts         *float64 `json:"restarts"`
	OOMKills         *float64 `json:"oomKills"`
	ThrottledPercent *float64 `json:"throttledPercent"`
}

type serverStatistics struct {
	Source   string         `json:"source"`
	Warnings []string       `json:"warnings"`
	Range    string         `json:"range"`
	Step     float64        `json:"step"`
	Pod      string         `json:"pod"`
	Node     *string        `json:"node"`
	CPU      resourceUsage  `json:"cpu"`
	Memory   resourceUsage  `json:"memory"`
	Network  serverNetwork  `json:"network"`
	Players  *playersSeries `json:"players"`
	Disk     serverDisk     `json:"disk"`
	Health   serverHealth   `json:"health"`
}

type serverData struct {
	cpu, memory, rx, tx, players    []prom.Series
	playersMax, rxTotal, txTotal    []prom.Sample
	rxPackets, txPackets, oom       []prom.Sample
	throttled, diskRead, diskWrite  []prom.Sample
	diskUsed, diskTotal, diskGrowth []prom.Sample
}

func queueServer(run *promRun, data *serverData, namespace, name string, spec rangeSpec, now time.Time) {
	pod := podMatch(namespace, name+"-0")
	server := serverMatch(namespace, name)
	game := `container="game",` + pod
	window := rateWindow(spec.step)
	duration := promDuration(spec.dur)
	start := now.Add(-spec.dur)
	run.series(&data.cpu, fmt.Sprintf(`sum(rate(container_cpu_usage_seconds_total{%s}[%s]))`, game, window), start, now, spec.step)
	run.series(&data.memory, fmt.Sprintf(`sum(container_memory_working_set_bytes{%s})`, game), start, now, spec.step)
	run.series(&data.rx, fmt.Sprintf(`sum(rate(container_network_receive_bytes_total{interface="eth0",%s}[%s]))`, pod, window), start, now, spec.step)
	run.series(&data.tx, fmt.Sprintf(`sum(rate(container_network_transmit_bytes_total{interface="eth0",%s}[%s]))`, pod, window), start, now, spec.step)
	run.series(&data.players, fmt.Sprintf(`max(gameplane_agent_players_online{%s})`, server), start, now, spec.step)
	run.instant(&data.playersMax, fmt.Sprintf(`max(gameplane_agent_players_max{%s})`, server))
	run.instant(&data.rxTotal, fmt.Sprintf(`sum(container_network_receive_bytes_total{interface="eth0",%s})`, pod))
	run.instant(&data.txTotal, fmt.Sprintf(`sum(container_network_transmit_bytes_total{interface="eth0",%s})`, pod))
	run.instant(&data.rxPackets, fmt.Sprintf(`sum(rate(container_network_receive_packets_total{interface="eth0",%s}[%s]))`, pod, window))
	run.instant(&data.txPackets, fmt.Sprintf(`sum(rate(container_network_transmit_packets_total{interface="eth0",%s}[%s]))`, pod, window))
	run.instant(&data.oom, fmt.Sprintf(`sum(container_oom_events_total{%s})`, game))
	run.instant(&data.throttled, fmt.Sprintf(`100 * sum(increase(container_cpu_cfs_throttled_periods_total{%s}[%s])) / sum(increase(container_cpu_cfs_periods_total{%s}[%s]))`, game, duration, game, duration))
	run.instant(&data.diskRead, fmt.Sprintf(`sum(rate(container_fs_reads_bytes_total{%s}[%s]))`, game, window))
	run.instant(&data.diskWrite, fmt.Sprintf(`sum(rate(container_fs_writes_bytes_total{%s}[%s]))`, game, window))
	run.instant(&data.diskUsed, fmt.Sprintf(`max(gameplane_agent_disk_used_bytes{%s})`, server))
	run.instant(&data.diskTotal, fmt.Sprintf(`max(gameplane_agent_disk_total_bytes{%s})`, server))
	run.instant(&data.diskGrowth, fmt.Sprintf(`max(delta(gameplane_agent_disk_used_bytes{%s}[%s]))`, server, duration))
}

func gameContainer(pod *corev1.Pod) *corev1.Container {
	for i := range pod.Spec.Containers {
		if pod.Spec.Containers[i].Name == "game" {
			return &pod.Spec.Containers[i]
		}
	}
	return nil
}

func gameRestarts(pod *corev1.Pod) *float64 {
	for _, status := range pod.Status.ContainerStatuses {
		if status.Name == "game" {
			restarts := float64(status.RestartCount)
			return &restarts
		}
	}
	return nil
}

func (h *statisticsHandler) server(w http.ResponseWriter, req *http.Request) {
	home, ok := h.home(w, req)
	if !ok {
		return
	}
	namespace, ok := resolveNS(w, req)
	if !ok {
		return
	}
	name := chi.URLParam(req, "name")
	if !dnsLabelRE.MatchString(name) {
		httperr.WriteMessage(w, req, messages.New(httperr.IDNotFound, nil))
		return
	}
	ctx := req.Context()
	podName := name + "-0"
	pod, err := home.k.Typed.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		pod = nil
	} else if err != nil {
		httperr.Write(w, req, err)
		return
	}
	spec := parseRange(req)
	now := h.now()
	var data serverData
	run := newPromRun(ctx, h.prom, now)
	queueServer(run, &data, namespace, name, spec, now)
	unreachable, partial := run.wait()
	prometheus := h.prom != nil && !unreachable
	if !prometheus {
		data = serverData{}
	}

	source := "none"
	if prometheus {
		source = "prometheus"
	}
	var node *string
	var restarts, cpuRequest, cpuLimit, memoryRequest, memoryLimit *float64
	if pod != nil {
		if pod.Spec.NodeName != "" {
			node = &pod.Spec.NodeName
		}
		restarts = gameRestarts(pod)
		if container := gameContainer(pod); container != nil {
			cpuRequest = optionalQuantity(container.Resources.Requests, corev1.ResourceCPU)
			cpuLimit = optionalQuantity(container.Resources.Limits, corev1.ResourceCPU)
			memoryRequest = optionalQuantity(container.Resources.Requests, corev1.ResourceMemory)
			memoryLimit = optionalQuantity(container.Resources.Limits, corev1.ResourceMemory)
		}
	}
	rx, tx := firstPoints(data.rx), firstPoints(data.tx)
	peak, p95 := trafficSummary(rx, tx)
	var players *playersSeries
	if online := firstPoints(data.players); len(online) > 0 {
		players = &playersSeries{Online: online, Max: firstValue(data.playersMax)}
	}
	writeJSON(w, serverStatistics{
		Source:   source,
		Warnings: warningsFor(unreachable, partial),
		Range:    spec.name,
		Step:     spec.step.Seconds(),
		Pod:      podName,
		Node:     node,
		CPU:      resourceUsage{Usage: firstPoints(data.cpu), Request: cpuRequest, Limit: cpuLimit},
		Memory:   resourceUsage{Usage: firstPoints(data.memory), Request: memoryRequest, Limit: memoryLimit},
		Network: serverNetwork{
			RX:           rx,
			TX:           tx,
			RXSinceStart: firstValue(data.rxTotal),
			TXSinceStart: firstValue(data.txTotal),
			Peak:         peak,
			P95:          p95,
			RXPackets:    firstValue(data.rxPackets),
			TXPackets:    firstValue(data.txPackets),
		},
		Players: players,
		Disk: serverDisk{
			Used:   firstValue(data.diskUsed),
			Total:  firstValue(data.diskTotal),
			Growth: firstValue(data.diskGrowth),
			Read:   firstValue(data.diskRead),
			Write:  firstValue(data.diskWrite),
		},
		Health: serverHealth{
			Restarts:         restarts,
			OOMKills:         firstValue(data.oom),
			ThrottledPercent: firstValue(data.throttled),
		},
	})
}
