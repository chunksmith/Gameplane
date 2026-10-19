# Feature Specification: Statistics

**Feature Branch**: `feat/statistics`
**Created**: 2026-10-19
**Status**: Implemented (merged in PR #67, 2026-10-19)
**Input**: Maintainer request (2026-10-19, in chat): "a general statistics page; CPU, RAM and bandwidth per node; detailed statistics; Prometheus may be used for the data; live usage cards at the very top; the same inside a server's page, specific to that pod."

## Clarifications

### Session 2026-10-19 (maintainer, in chat)

- Data source: an **external Prometheus**, set by URL in Helm (`metrics.prometheus.url`). The chart does not ship Prometheus.
- Design: designed in Penpot and approved before code (core rule 1). File "Gameplane Dashboard", project "Gameplane". Approved boards:
  - Statistics / Desktop / Dark (`a00ae18d-ddd5-80da-8008-d03b8a9c5ed3`) and Light (`…d03e9a2b37d0`)
  - Statistics / Mobile / Dark (`…d03e27005412`) and Light (`…d03e9dd44d1a`)
  - Statistics / Node / Desktop / Dark (`…d03ce4d00a1f`) and Light (`…d03e9b666866`)
  - Statistics / Desktop / Dark / No Prometheus (`…d03d8c581dda`) and Light (`…d03e9c48a564`)
  - Server / Statistics / Desktop / Dark (`…d059d1493e64`) and Light (`…d05c128894b2`)
  - Server / Statistics / Mobile / Dark (`…d05bc9012011`) and Light (`…d05c14834c10`)
- The server tab builds on PR #66 (merged into `master`), which puts live stat cards above every server tab. Those cards stay on every tab, Statistics included. The Statistics tab adds **no second live-card row** (maintainer choice) and starts with the range selector and the history charts.

## Design

### Screens

1. **`/statistics`**, a sidebar item under General, right after Dashboard. It is gated by `cluster:read` (same as `/cluster`).
   - **Header**: title, subtitle, a node picker (choosing a node opens its detail page), and a range selector (15m, 1h, 6h, 24h, 7d, 30d; default 24h).
   - **Live usage**: four cards (CPU, Memory, Inbound, Outbound) with a 15-minute sparkline. They refresh every 10s.
   - **Network throughput**: cluster-wide line chart (in and out) with totals, peak and p95 for the range. Next to it, **Bandwidth by node**: per-node in/out split bars.
   - **Utilization heatmap**: node × 24 buckets, switchable between CPU, Memory and Network.
   - **Nodes table**: status, CPU and memory meters, net in/out, load, pods, and a CPU trend. Each row links to the node page.
   - **Top game servers**: sortable by CPU, memory or network, filtered by `servers:read`.
2. **`/statistics/nodes/$name`**:
   - **Header**: node identity (Ready pill, cores, memory, IP, OS, kernel, kubelet, uptime) and the range selector.
   - **Live usage**: four cards.
   - **CPU and memory charts**: usage plus a dashed "requested" line.
   - **Network throughput**: chart plus a per-interface table.
   - **System**: load 1/5/15, disk I/O and filesystems.
   - **Game servers on this node**.
3. **Without Prometheus** (`source` other than `prometheus`):
   - A callout with the Helm value to set.
   - CPU and memory live cards from metrics-server, with history gathered client-side since the page opened.
   - The network cards show a "no bandwidth data" placeholder.
   - The nodes table shows dashes for the network, load and trend columns.
   - The history sections are hidden.
4. **Server detail → Statistics tab**, right after Overview. It is shown only for home-cluster servers.
   - **Header**: a "History" label with the pod and node, and the range selector.
   - **CPU chart**: cores, with request (dashed) and limit lines.
   - **Memory chart**: GB, with request and limit (warning) lines.
   - **Network throughput**: chart with since-start totals, peak, p95 and packets.
   - **Players online**.
   - **Storage & health**: `/data` meter, disk growth, disk I/O, CPU throttled, restarts, OOM kills, and a link to the node page.

### Chart colors

- **CPU**: `--accent`
- **Memory**: `--chart-stat` (violet)
- **Inbound**: new `--chart-inbound`
- **Outbound**: new `--chart-outbound`
- **Players**: new `--chart-players`
- **Thresholds**: `--muted` (request) and `--warning` (limit)

The new tokens are stepped per mode from the dataviz reference palette and validated with its palette script (inbound/outbound pass every check in both modes against the card surfaces):

| token | light | dark |
|---|---|---|
| `--chart-inbound` | `#2A78D6` | `#3987E5` |
| `--chart-outbound` | `#EB6834` | `#D95926` |
| `--chart-players` | `#1BAF7A` | `#199E70` |

### API

Four home-cluster GET routes; see [contracts/statistics-api.md](contracts/statistics-api.md).

- New `api/internal/prom` client. It dials through `netguard.HTTPClient(timeout, netguard.IsAllowed)`, like notification sinks: an admin-set in-cluster URL is expected.
- New flag `--prometheus-url` / env `GAMEPLANE_PROMETHEUS_URL`.
- New rbac rule `GET statistics → cluster:read`, placed before the catch-all.

### Out of scope

- Shipping Prometheus or node-exporter in the chart.
- Per-cluster Prometheus for remote clusters.
- Alerting.
- Persisting statistics in the Gameplane database.
