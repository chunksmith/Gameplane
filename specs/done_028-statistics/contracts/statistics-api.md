# Contract: Statistics API

All four routes are GET, JSON, and **home-cluster only**: a `?cluster=` naming any other registered cluster answers `501` through `rejectRemoteCluster` (api/specs.md key invariant 16). The Prometheus URL is one install-wide Helm value, so there is no per-cluster Prometheus.

Units are fixed across every field: CPU in **cores** (float), memory and disk in **bytes**, network rates in **bytes per second**, packet rates in **packets per second**, timestamps in **unix seconds**. A value the source cannot supply is `null`, never `0`.

```ts
type Point = [number, number];               // [unixSeconds, value]
type StatisticsSource = "prometheus" | "metrics-server" | "none";
type StatisticsRange = "15m" | "1h" | "6h" | "24h" | "7d" | "30d";
type StatisticsWarning = "prometheus_unreachable" | "prometheus_partial";
```

`warnings` is always present (possibly empty):
- `prometheus_unreachable`: a Prometheus URL is configured but the request failed, so the response degraded to `metrics-server` or `none`.
- `prometheus_partial`: some queries failed and their fields are `null` or `[]`.

## Ranges

`?range=` takes one of the values below. A missing or unknown value means `24h`; it is never a 400. `step` is the query_range resolution. Counter rates use the window `max(step, 1m)`.

| range | step | points |
|---|---|---|
| 15m | 15s | 60 |
| 1h | 30s | 120 |
| 6h | 3m | 120 |
| 24h | 15m | 96 |
| 7d | 2h | 84 |
| 30d | 6h | 120 |

Live sparklines always cover the last 15 minutes at a 30s step (30 points), whatever `range` is.

## GET /statistics/live

Permission: `cluster:read` on the home cluster (new rbac rule, segment `statistics`). The page polls it every 10s.

```ts
interface StatisticsLive {
  source: StatisticsSource;            // prometheus, else metrics-server (live CPU/memory only), else none
  warnings: StatisticsWarning[];
  generatedAt: string;                 // RFC3339
  cluster: {
    cpu: { used: number | null; capacity: number; series: Point[] };      // series [] unless prometheus
    memory: { used: number | null; capacity: number; series: Point[] };
    network: { rx: number | null; tx: number | null; rxSeries: Point[]; txSeries: Point[] } | null;  // null unless prometheus
  };
  nodes: StatisticsNodeSummary[];      // every node from the Kubernetes API, sorted by name
  servers: StatisticsServerSummary[];  // [] unless prometheus; only namespaces where the caller holds servers:read on the home cluster
}

interface StatisticsNodeSummary {
  name: string;
  ready: boolean;
  internalIP?: string;
  cpuCapacity: number;                 // cores, node status capacity
  memoryCapacity: number;              // bytes, node status capacity
  pods: number;                        // non-terminated pods scheduled on the node
  cpuUsed: number | null;
  memoryUsed: number | null;
  rx: number | null;                   // physical interfaces only (filter below)
  tx: number | null;
  load1: number | null;
}

interface StatisticsServerSummary {
  name: string;                        // GameServer name; its pod is `${name}-0`
  namespace: string;
  node: string | null;
  cpu: number | null;
  cpuLimit: number | null;
  memory: number | null;
  memoryLimit: number | null;
  rx: number | null;
  tx: number | null;
  players: number | null;
  maxPlayers: number | null;           // -1 = unlimited, as the agent reports it
}
```

`cluster.cpu.capacity` and `cluster.memory.capacity` are the sums of the node capacities. With `metrics-server`, `used` comes from `fetchNodeUsage` (summed for the cluster).

## GET /statistics/history?range=

Permission: `cluster:read`. The page polls it every 60s.

```ts
interface StatisticsHistory {
  source: "prometheus" | "none";
  warnings: StatisticsWarning[];
  range: StatisticsRange;
  step: number;                        // seconds
  start: number;                       // unix seconds
  end: number;
  network: {
    rx: Point[];                       // cluster-wide B/s
    tx: Point[];
    rxTotal: number | null;            // bytes transferred over the range
    txTotal: number | null;
    peak: { value: number; at: number } | null;   // max of rx+tx
    p95: number | null;                // 95th percentile of rx+tx
  } | null;
  heatmap: {
    buckets: number[];                 // 24 bucket timestamps (unix seconds), step = range / 24
    cpu: Record<string, (number | null)[]>;      // node -> percent of capacity, 0..100
    memory: Record<string, (number | null)[]>;   // node -> percent of capacity, 0..100
    network: Record<string, (number | null)[]>;  // node -> rx+tx B/s
  } | null;
  nodeCpu: Record<string, Point[]>;    // node -> CPU percent at `step`, for the table trend column
}
```

## GET /statistics/nodes/{name}?range=

Permission: `cluster:read`. `{name}` must match `^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$`, else `404`. An unknown node is `404`. The page polls it every 15s.

```ts
interface StatisticsNodeDetail {
  source: StatisticsSource;
  warnings: StatisticsWarning[];
  range: StatisticsRange;
  step: number;
  node: StatisticsNodeSummary & {
    osImage?: string;
    kernelVersion?: string;
    kubeletVersion?: string;
    bootTime: number | null;           // unix seconds, node_boot_time_seconds
  };
  live: {
    load5: number | null;
    load15: number | null;
    diskRead: number | null;           // B/s across physical disks
    diskWrite: number | null;
    cpuSeries: Point[];                // last 15m, cores
    memorySeries: Point[];             // last 15m, bytes
    rxSeries: Point[];
    txSeries: Point[];
  };
  cpu: { usage: Point[]; requested: number | null };      // cores; requested = sum of pod requests on the node now
  memory: { usage: Point[]; requested: number | null };   // bytes
  network: { rx: Point[]; tx: Point[] };
  interfaces: {
    name: string;
    rx: number | null; tx: number | null;                 // B/s now
    rxPackets: number | null; txPackets: number | null;   // packets/s now
    rxTotal: number | null; txTotal: number | null;       // bytes over the range
    errors: number | null; drops: number | null;          // count over the range, rx+tx
  }[];                                                    // every device except lo and veth*
  filesystems: { mountpoint: string; device: string; fstype: string; size: number; used: number }[];
  servers: StatisticsServerSummary[];                     // servers whose pod runs on this node, filtered by servers:read
}
```

Without Prometheus, `node` and `live` carry what the Kubernetes API and metrics-server know; every series is `[]`, and `interfaces`, `filesystems` and `servers` are `[]`.

## GET /servers/{name}/statistics?range=

Permission: `servers:read` (existing `servers` rule; owner and collaborator fallback apply). The namespace is resolved with `resolveNS`, and the pod is `${name}-0`. The tab polls it every 15s.

```ts
interface ServerStatistics {
  source: "prometheus" | "none";
  warnings: StatisticsWarning[];
  range: StatisticsRange;
  step: number;
  pod: string;
  node: string | null;                 // pod spec.nodeName
  cpu: { usage: Point[]; request: number | null; limit: number | null };       // cores; request/limit from the game container spec
  memory: { usage: Point[]; request: number | null; limit: number | null };    // bytes
  network: {
    rx: Point[]; tx: Point[];
    rxSinceStart: number | null; txSinceStart: number | null;  // current cAdvisor counter value (bytes)
    peak: { value: number; at: number } | null;                // max of rx+tx over the range
    p95: number | null;
    rxPackets: number | null; txPackets: number | null;        // packets/s now
  };
  players: { online: Point[]; max: number | null } | null;     // null when the agent gauge has no series
  disk: { used: number | null; total: number | null; growth: number | null; read: number | null; write: number | null };
  health: { restarts: number | null; oomKills: number | null; throttledPercent: number | null };
}
```

`restarts` comes from the pod's `game` container status. `throttledPercent` is `null` when the container has no CPU limit (no CFS periods).

## PromQL

`<R>` is the rate window. `<NS>`, `<POD>`, `<SERVER>` and `<NODE>` are label values passed through `prom.Quote`, after validation against the Kubernetes name rules. The browser never sends PromQL.

**Node identity.** node-exporter's `instance` is `IP:9100`. Every node expression is joined to its Kubernetes name with
```
<expr> * on(instance) group_left(nodename) node_uname_info
```
and is aggregated `by (nodename)`.

**Physical interface filter** (`PHYS`), used for node bandwidth totals:
```
device!~"lo|veth.*|cni.*|flannel.*|cali.*|vxlan.*|docker.*|br-.*|virbr.*|tailscale.*|tun.*|wg.*|kube-.*|cilium.*|lxc.*|genev.*"
```

**Node queries**

| field | expression |
|---|---|
| CPU used (cores) | `sum by (nodename) (1 - rate(node_cpu_seconds_total{mode="idle"}[<R>]) * on(instance) group_left(nodename) node_uname_info)` |
| memory used (bytes) | `sum by (nodename) ((node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) * on(instance) group_left(nodename) node_uname_info)` |
| rx (B/s) | `sum by (nodename) (rate(node_network_receive_bytes_total{PHYS}[<R>]) * on(instance) group_left(nodename) node_uname_info)` |
| tx (B/s) | the same with `node_network_transmit_bytes_total` |
| load1/5/15 | `max by (nodename) (node_load1 * on(instance) group_left(nodename) node_uname_info)` (likewise `node_load5` and `node_load15`) |
| disk read/write | `sum by (nodename) (rate(node_disk_read_bytes_total[<R>]) * on(instance) group_left(nodename) node_uname_info)` (and `node_disk_written_bytes_total`) |
| boot time | `max by (nodename) (node_boot_time_seconds * on(instance) group_left(nodename) node_uname_info)` |
| per-interface | `node_network_{receive,transmit}_{bytes,packets}_total{device!~"lo\|veth.*"}`, with `rate` for current values, `increase(...[<range>])` for totals, and `node_network_{receive,transmit}_{errs,drop}_total` increase for errors and drops, filtered `nodename=<NODE>` after the join |
| filesystems | `node_filesystem_size_bytes` and `node_filesystem_avail_bytes` with `fstype!~"tmpfs\|overlay\|squashfs\|nsfs\|ramfs\|fuse.*\|autofs\|devtmpfs"`, joined; used = size - avail |

Heatmap and percent fields divide by the node capacity from the Kubernetes API, on the Go side rather than in PromQL.

**Pod and server queries.** The game container is named `game`, and the pod is `<SERVER>-0`.

| field | expression |
|---|---|
| CPU (cores) | `sum by (namespace, pod, node) (rate(container_cpu_usage_seconds_total{container="game"[,namespace=<NS>,pod=<POD>]}[<R>]))` |
| memory (bytes) | `sum by (namespace, pod) (container_memory_working_set_bytes{container="game"[,...]})` |
| rx and tx (B/s) | `sum by (namespace, pod) (rate(container_network_receive_bytes_total{interface="eth0"[,...]}[<R>]))` (and transmit) |
| rx and tx since start | `sum by (namespace, pod) (container_network_receive_bytes_total{interface="eth0",namespace=<NS>,pod=<POD>})` |
| packets | `rate(container_network_{receive,transmit}_packets_total{interface="eth0",...}[<R>])` |
| OOM kills | `sum(container_oom_events_total{container="game",namespace=<NS>,pod=<POD>})` |
| throttled % | `100 * sum(increase(container_cpu_cfs_throttled_periods_total{container="game",...}[<range>])) / sum(increase(container_cpu_cfs_periods_total{container="game",...}[<range>]))` |
| disk read/write | `sum(rate(container_fs_reads_bytes_total{container="game",...}[<R>]))` (and `container_fs_writes_bytes_total`), `null` when absent |
| players | `max by (namespace, server) (gameplane_agent_players_online[{namespace=<NS>,server=<SERVER>}])` and `gameplane_agent_players_max` |
| limits (overview list) | `max by (namespace, server) (gameplane_agent_cpu_limit_millicores) / 1000` and `gameplane_agent_memory_limit_bytes` |
| disk used/total | `max(gameplane_agent_disk_used_bytes{namespace=<NS>,server=<SERVER>})` and `gameplane_agent_disk_total_bytes` |
| disk growth | `max(delta(gameplane_agent_disk_used_bytes{namespace=<NS>,server=<SERVER>}[<range>]))` |

In the overview server list, servers are the `(namespace, server)` pairs of `gameplane_agent_players_online` unioned with the pods matching `<server>-0` that have a `container="game"` CPU series. The list joins on pod = `server + "-0"`.

The `gameplane_agent_*` gauges exist only when Prometheus scrapes the agent (`serviceMonitors.enabled`; `docs/install.md` Observability). cAdvisor and node-exporter come from the operator's own Prometheus stack (kube-prometheus-stack ships both).
