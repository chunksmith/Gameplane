import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowRight, ArrowUpFromLine, ChartLine, ChevronRight, Cpu, MemoryStick } from "lucide-react";
import { Card, ListBox, ListBoxItem, Select, buttonVariants } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { PageHeader } from "@/components/PageHeader";
import { ErrorCard } from "@/components/ui/ErrorCard";
import { LoadingCard } from "@/components/ui/LoadingCard";
import { Sparkline } from "@/components/ui/Sparkline";
import { ChartLegend, LineChart } from "@/components/statistics/LineChart";
import { LiveCard } from "@/components/statistics/LiveCard";
import { Heatmap } from "@/components/statistics/Heatmap";
import { SplitBars } from "@/components/statistics/SplitBars";
import { RangeSelect } from "@/components/statistics/RangeSelect";
import { SegmentedControl } from "@/components/statistics/SegmentedControl";
import { InlineMeter } from "@/components/statistics/InlineMeter";
import { Statistics } from "@/lib/endpoints";
import { useFormat, useOptionalIntl, type FormatApi } from "@/lib/i18n/format";
import { STATISTICS_SETUP_URL } from "@/lib/links";
import { DEFAULT_RANGE, formatBits, formatRate, formatTick, percent, seriesDelta, seriesPeak } from "@/lib/statistics";
import { cn, formatBytes, formatRelative } from "@/lib/utils";
import type {
  StatisticsHistory,
  StatisticsNodeSummary,
  StatisticsPoint,
  StatisticsRange,
  StatisticsServerSummary,
  StatisticsSource,
  StatisticsWarning,
} from "@/types";

export const messages: Record<string, MessageDescriptor> = defineMessages({
  title: { id: "web.routes.statistics.title", defaultMessage: "Statistics", description: "Statistics overview: page title; also the sidebar label" },
  subtitlePrometheus: { id: "web.routes.statistics.subtitle_prometheus", defaultMessage: "Node CPU, memory and network usage across the cluster, from Prometheus.", description: "Statistics overview: subtitle when history and bandwidth come from Prometheus" },
  subtitleMetricsServer: { id: "web.routes.statistics.subtitle_metrics_server", defaultMessage: "Live node CPU and memory from metrics-server. Connect Prometheus for history and bandwidth.", description: "Statistics overview: subtitle when only live metrics-server data is available" },
  nodePicker: { id: "web.routes.statistics.node_picker", defaultMessage: "Node", description: "Statistics: accessible name of the node dropdown; picking a node opens that node's statistics page" },
  allNodes: { id: "web.routes.statistics.all_nodes", defaultMessage: "All nodes", description: "Statistics: first choice of the node dropdown, which keeps the cluster-wide overview" },
  connectTitle: { id: "web.routes.statistics.connect_title", defaultMessage: "Connect Prometheus to unlock history, bandwidth and heatmaps", description: "Statistics: heading of the callout shown when Prometheus is not configured" },
  connectBody: { id: "web.routes.statistics.connect_body", defaultMessage: "Set metrics.prometheus.url in the Helm values to a Prometheus that scrapes node-exporter and cAdvisor. kube-prometheus-stack works as is.", description: "Statistics: body of the callout shown when Prometheus is not configured; metrics.prometheus.url is a Helm value name, shown as code" },
  unreachableTitle: { id: "web.routes.statistics.unreachable_title", defaultMessage: "Prometheus is unreachable", description: "Statistics: heading of the callout shown when a configured Prometheus does not answer" },
  unreachableBody: { id: "web.routes.statistics.unreachable_body", defaultMessage: "Check that metrics.prometheus.url in the Helm values points to a Prometheus that is running and reachable from the API. Live values still come from metrics-server.", description: "Statistics: body of the callout shown when a configured Prometheus does not answer; metrics.prometheus.url is a Helm value name" },
  setupGuide: { id: "web.routes.statistics.setup_guide", defaultMessage: "Setup guide", description: "Statistics: button that opens the Prometheus setup documentation in a new tab" },
  partial: { id: "web.routes.statistics.partial", defaultMessage: "Some Prometheus queries failed. Affected values show as —.", description: "Statistics: muted warning line shown when some Prometheus queries failed and their values are missing" },
  liveUsage: { id: "web.routes.statistics.live_usage", defaultMessage: "Live usage", description: "Statistics: section label above the live CPU, memory and network cards" },
  live: { id: "web.routes.statistics.live", defaultMessage: "Live", description: "Statistics: green pill meaning the values refresh automatically" },
  liveUpdated: { id: "web.routes.statistics.live_updated", defaultMessage: "Updated {relative} · refreshes every 10s", description: "Statistics: line under the live usage label; {relative} is how long ago the values were fetched, such as 4s ago" },
  cpu: { id: "web.routes.statistics.cpu", defaultMessage: "CPU", description: "Statistics: label of the cluster CPU card; technical term, usually left untranslated" },
  memory: { id: "web.routes.statistics.memory", defaultMessage: "Memory", description: "Statistics: label of the cluster memory card" },
  inbound: { id: "web.routes.statistics.inbound", defaultMessage: "Inbound", description: "Statistics: label of the card and legend entry for incoming network traffic" },
  outbound: { id: "web.routes.statistics.outbound", defaultMessage: "Outbound", description: "Statistics: label of the card and legend entry for outgoing network traffic" },
  needsPrometheus: { id: "web.routes.statistics.needs_prometheus", defaultMessage: "Needs Prometheus", description: "Statistics: text under a network card when network rates need Prometheus, which is not connected" },
  cpuSub: { id: "web.routes.statistics.cpu_sub", defaultMessage: "{used} of {capacity} cores in use", description: "Statistics: CPU card subtitle; {used} and {capacity} are core counts" },
  memorySub: { id: "web.routes.statistics.memory_sub", defaultMessage: "{used} of {capacity} in use", description: "Statistics: memory card subtitle; {used} and {capacity} are byte sizes" },
  networkSub: { id: "web.routes.statistics.network_sub", defaultMessage: "{rate} across {count, plural, one {# node} other {# nodes}}", description: "Statistics: network card subtitle; {rate} is the rate in Mbit/s and {count} the number of nodes" },
  deltaPoints: { id: "web.routes.statistics.delta_points", defaultMessage: "{value} pt", description: "Statistics: change since the start of the live window, in percentage points; {value} is the number" },
  deltaPercent: { id: "web.routes.statistics.delta_percent", defaultMessage: "{value}% vs 15m", description: "Statistics: relative change over the last 15 minutes; {value} is the percentage" },
  networkTitle: { id: "web.routes.statistics.network_title", defaultMessage: "Network throughput", description: "Statistics: title of the cluster network throughput chart" },
  networkSubtitle: { id: "web.routes.statistics.network_subtitle", defaultMessage: "Cluster-wide, all node interfaces · last {range}", description: "Statistics: subtitle of the network chart; {range} is the selected time range such as 24h" },
  totalIn: { id: "web.routes.statistics.total_in", defaultMessage: "Total in", description: "Statistics: mini stat with the bytes received over the selected range" },
  totalOut: { id: "web.routes.statistics.total_out", defaultMessage: "Total out", description: "Statistics: mini stat with the bytes sent over the selected range" },
  peak: { id: "web.routes.statistics.peak", defaultMessage: "Peak", description: "Statistics: mini stat with the highest network rate over the selected range" },
  p95: { id: "web.routes.statistics.p95", defaultMessage: "p95", description: "Statistics: mini stat label for the 95th percentile of the network rate; keep the short form" },
  bandwidthTitle: { id: "web.routes.statistics.bandwidth_title", defaultMessage: "Bandwidth by node", description: "Statistics: title of the card that compares current inbound and outbound traffic per node" },
  bandwidthSubtitle: { id: "web.routes.statistics.bandwidth_subtitle", defaultMessage: "Current in + out, MB/s", description: "Statistics: subtitle of the bandwidth by node card" },
  legendIn: { id: "web.routes.statistics.legend_in", defaultMessage: "In", description: "Statistics: short legend label for inbound traffic" },
  legendOut: { id: "web.routes.statistics.legend_out", defaultMessage: "Out", description: "Statistics: short legend label for outbound traffic" },
  heatmapTitle: { id: "web.routes.statistics.heatmap_title", defaultMessage: "Utilization heatmap", description: "Statistics: title of the heatmap of average utilization per node and time bucket" },
  heatmapSubtitle: { id: "web.routes.statistics.heatmap_subtitle", defaultMessage: "Average per node · last {range}", description: "Statistics: subtitle of the heatmap; {range} is the selected time range such as 24h" },
  heatmapSwitch: { id: "web.routes.statistics.heatmap_switch", defaultMessage: "Heatmap metric", description: "Statistics: accessible name of the CPU, Memory and Network switch above the heatmap" },
  metricCpu: { id: "web.routes.statistics.metric_cpu", defaultMessage: "CPU", description: "Statistics: switch option for CPU; technical term, usually left untranslated" },
  metricMemory: { id: "web.routes.statistics.metric_memory", defaultMessage: "Memory", description: "Statistics: switch option for memory" },
  metricNetwork: { id: "web.routes.statistics.metric_network", defaultMessage: "Network", description: "Statistics: switch option for network traffic" },
  percentValue: { id: "web.routes.statistics.percent_value", defaultMessage: "{value}%", description: "Statistics: a percentage of capacity in use; {value} is a whole number" },
  unitPercent: { id: "web.routes.statistics.unit_percent", defaultMessage: "%", description: "Statistics: unit shown after a live CPU or memory percentage" },
  unitMbps: { id: "web.routes.statistics.unit_mbps", defaultMessage: "MB/s", description: "Statistics: unit shown after a live network rate in megabytes per second" },
  rateMbps: { id: "web.routes.statistics.rate_mbps", defaultMessage: "{value} MB/s", description: "Statistics: network rate in megabytes per second on a chart axis or as a peak; {value} is the number" },
  mobileCpu: { id: "web.routes.statistics.mobile_cpu", defaultMessage: "CPU", description: "Statistics nodes list on phones: label of the CPU meter; technical term, usually left untranslated" },
  mobileMemory: { id: "web.routes.statistics.mobile_memory", defaultMessage: "Mem", description: "Statistics nodes list on phones: short label of the memory meter" },
  mobileRates: { id: "web.routes.statistics.mobile_rates", defaultMessage: "↓{rx} ↑{tx}", description: "Statistics nodes list on phones: current inbound and outbound rate of a node; {rx} and {tx} are rates in MB/s, or — when unknown" },
  nodesTitle: { id: "web.routes.statistics.nodes_title", defaultMessage: "Nodes", description: "Statistics: title of the node table" },
  nodesSubtitle: { id: "web.routes.statistics.nodes_subtitle", defaultMessage: "{count, plural, one {# node} other {# nodes}} · {cores} cores · {memory} memory · select a node for details", description: "Statistics: subtitle of the node table with totals; {cores} is a core count and {memory} a byte size" },
  columnNode: { id: "web.routes.statistics.column_node", defaultMessage: "Node", description: "Statistics node table: column with the node name" },
  columnStatus: { id: "web.routes.statistics.column_status", defaultMessage: "Status", description: "Statistics node table: column with the Ready or NotReady status" },
  columnCpu: { id: "web.routes.statistics.column_cpu", defaultMessage: "CPU", description: "Statistics node table: column with CPU utilization of the node" },
  columnMemory: { id: "web.routes.statistics.column_memory", defaultMessage: "Memory", description: "Statistics node table: column with memory utilization of the node" },
  columnNetIn: { id: "web.routes.statistics.column_net_in", defaultMessage: "Net in", description: "Statistics node table: column with the inbound network rate of the node" },
  columnNetOut: { id: "web.routes.statistics.column_net_out", defaultMessage: "Net out", description: "Statistics node table: column with the outbound network rate of the node" },
  columnLoad: { id: "web.routes.statistics.column_load", defaultMessage: "Load 1m", description: "Statistics node table: column with the one-minute load average" },
  columnPods: { id: "web.routes.statistics.column_pods", defaultMessage: "Pods", description: "Statistics node table: column with the number of pods on the node" },
  columnTrend: { id: "web.routes.statistics.column_trend", defaultMessage: "CPU · {range}", description: "Statistics node table: column with a sparkline of the node CPU over the selected range; {range} is the time range such as 24h" },
  columnServer: { id: "web.routes.statistics.column_server", defaultMessage: "Server", description: "Statistics top game servers table: column with the game server name" },
  columnNet: { id: "web.routes.statistics.column_net", defaultMessage: "Net in / out", description: "Statistics top game servers table: column with the inbound and outbound network rate" },
  columnPlayers: { id: "web.routes.statistics.column_players", defaultMessage: "Players", description: "Statistics top game servers table: column with players online and the player capacity" },
  nodeSpec: { id: "web.routes.statistics.node_spec", defaultMessage: "{cores} cores · {memory} · {ip}", description: "Statistics node table: muted line under the node name with core count, memory and internal IP address" },
  nodeSpecNoIp: { id: "web.routes.statistics.node_spec_no_ip", defaultMessage: "{cores} cores · {memory}", description: "Statistics node table: muted line under the node name when the node has no internal IP address" },
  statusReady: { id: "web.routes.statistics.status_ready", defaultMessage: "Ready", description: "Statistics: status pill for a node that is ready" },
  statusNotReady: { id: "web.routes.statistics.status_not_ready", defaultMessage: "NotReady", description: "Statistics: status pill for a node that is not ready" },
  serversTitle: { id: "web.routes.statistics.servers_title", defaultMessage: "Top game servers", description: "Statistics: title of the table of the game servers with the highest current usage" },
  serversSubtitle: { id: "web.routes.statistics.servers_subtitle", defaultMessage: "Highest current usage across all nodes", description: "Statistics: subtitle of the top game servers table" },
  serversSwitch: { id: "web.routes.statistics.servers_switch", defaultMessage: "Sort game servers by", description: "Statistics: accessible name of the CPU, Memory and Network switch that sorts the top game servers" },
  serverScope: { id: "web.routes.statistics.server_scope", defaultMessage: "local / {namespace}", description: "Statistics: muted line under a game server name with the cluster name and the Kubernetes namespace; local is the home cluster" },
  serverCpu: { id: "web.routes.statistics.server_cpu", defaultMessage: "{used} / {limit} cores", description: "Statistics: game server CPU as used and limit cores" },
  serverMemory: { id: "web.routes.statistics.server_memory", defaultMessage: "{used} / {limit}", description: "Statistics: game server memory as used and limit byte sizes" },
  serverNet: { id: "web.routes.statistics.server_net", defaultMessage: "{inbound} / {outbound} MB/s", description: "Statistics: game server inbound and outbound rate in MB/s" },
  serverPlayers: { id: "web.routes.statistics.server_players", defaultMessage: "{online} / {max}", description: "Statistics: game server players online and the player capacity" },
  unlimited: { id: "web.routes.statistics.unlimited", defaultMessage: "∞", description: "Statistics: player capacity shown when the server has no player limit" },
  empty: { id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" },
  loading: { id: "web.routes.statistics.loading", defaultMessage: "Loading statistics…", description: "Statistics: loading message while the live statistics are fetched" },
  error: { id: "web.routes.statistics.error", defaultMessage: "Couldn't load statistics.", description: "Statistics: error card message when the live statistics cannot be loaded" },
  historyError: { id: "web.routes.statistics.history_error", defaultMessage: "Couldn't load statistics history.", description: "Statistics: error card message when the history for the selected range cannot be loaded" },
});

const metricMessages = defineMessages({
  cpu: messages.metricCpu,
  memory: messages.metricMemory,
  network: messages.metricNetwork,
});

export type Metric = "cpu" | "memory" | "network";
const METRICS: Metric[] = ["cpu", "memory", "network"];

const ROLLING_POINTS = 90;
const TOP_SERVER_COUNT = 8;
const NODE_COLUMNS = "@5xl:grid-cols-[minmax(0,1.6fr)_7.5rem_minmax(0,1.2fr)_minmax(0,1.2fr)_5.5rem_5.5rem_4.5rem_3.5rem_6.5rem_1rem]";
const SERVER_COLUMNS = "@4xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)_minmax(0,1.1fr)_minmax(0,0.9fr)]";
const HEATMAP_COLOR: Record<Metric, string> = { cpu: "var(--accent)", memory: "var(--chart-stat)", network: "var(--chart-inbound)" };
const HEADER_CLASS = "text-[11px] font-semibold uppercase tracking-wider text-muted";

type Trend = { text: string; direction: "up" | "down" | "flat" };

export function toPercentSeries(points: StatisticsPoint[], capacity: number): StatisticsPoint[] {
  if (capacity <= 0) return [];
  return points.map(([time, value]): StatisticsPoint => [time, (value / capacity) * 100]);
}

export function percentChange(points: StatisticsPoint[]): number | null {
  const delta = seriesDelta(points);
  if (delta === null || points[0][1] === 0) return null;
  return (delta / points[0][1]) * 100;
}

export function trendOf(delta: number | null, describe: (value: number) => string): Trend | undefined {
  if (delta === null) return undefined;
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return { text: describe(Math.abs(delta)), direction };
}

export function peakOf(points: StatisticsPoint[], describe: (value: number) => string): string | undefined {
  const peak = seriesPeak(points);
  return peak === null ? undefined : describe(peak[1]);
}

export function mbps(bytesPerSecond: number, format: FormatApi): string {
  const megabytes = bytesPerSecond / 1e6;
  return format.number(megabytes, megabytes < 100 ? { minimumFractionDigits: 1, maximumFractionDigits: 1 } : { maximumFractionDigits: 0 });
}

function useRollingSeries(value: number | null, updatedAt: number): StatisticsPoint[] {
  const [rolling, setRolling] = useState<{ updatedAt: number; points: StatisticsPoint[] }>({ updatedAt: 0, points: [] });
  if (value !== null && updatedAt !== rolling.updatedAt) {
    setRolling({ updatedAt, points: [...rolling.points, [updatedAt / 1000, value] as StatisticsPoint].slice(-ROLLING_POINTS) });
  }
  return rolling.points;
}

export function StatisticsPage() {
  const intl = useOptionalIntl();
  const format = useFormat();
  const navigate = useNavigate();
  const { range: requestedRange } = useSearch({ from: "/app-layout/statistics" });
  const range = requestedRange ?? DEFAULT_RANGE;
  const live = useQuery({ queryKey: ["statistics", "live"], queryFn: ({ signal }) => Statistics.live(signal), refetchInterval: 10_000 });
  const prometheus = live.data?.source === "prometheus";
  const history = useQuery({
    queryKey: ["statistics", "history", range],
    queryFn: ({ signal }) => Statistics.history(range, signal),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    enabled: prometheus,
  });

  const cluster = live.data?.cluster;
  const cpuPct = percent(cluster?.cpu.used ?? null, cluster?.cpu.capacity ?? 0);
  const memoryPct = percent(cluster?.memory.used ?? null, cluster?.memory.capacity ?? 0);
  const rollingCpu = useRollingSeries(cpuPct, live.dataUpdatedAt);
  const rollingMemory = useRollingSeries(memoryPct, live.dataUpdatedAt);
  const cpuSeries = prometheus ? toPercentSeries(cluster?.cpu.series ?? [], cluster?.cpu.capacity ?? 0) : rollingCpu;
  const memorySeries = prometheus ? toPercentSeries(cluster?.memory.series ?? [], cluster?.memory.capacity ?? 0) : rollingMemory;
  const network = cluster?.network ?? null;
  const rxPoints = network?.rxSeries ?? [];
  const txPoints = network?.txSeries ?? [];
  const nodes = live.data?.nodes ?? [];
  const servers = live.data?.servers ?? [];

  const oneDecimal = (value: number) => format.number(value, { maximumFractionDigits: 1 });
  const percentText = (value: number | null) => (value === null ? null : oneDecimal(value));
  const setRange = (next: StatisticsRange) => void navigate({ to: "/statistics", search: { range: next } });
  const pointsDelta = (value: number) => intl.formatMessage(messages.deltaPoints, { value: oneDecimal(value) });
  const percentDelta = (value: number) => intl.formatMessage(messages.deltaPercent, { value: oneDecimal(value) });

  return (
    <div className="min-w-0 space-y-6 p-6">
      <PageHeader
        title={intl.formatMessage(messages.title)}
        subtitle={intl.formatMessage(prometheus ? messages.subtitlePrometheus : messages.subtitleMetricsServer)}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value=""
              onChange={(next) => {
                if (next) void navigate({ to: "/statistics/nodes/$name", params: { name: String(next) }, search: { range } });
              }}
              aria-label={intl.formatMessage(messages.nodePicker)}
              className="w-48"
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator className="ml-auto h-4 w-4" />
              </Select.Trigger>
              <Select.Popover>
                <ListBox aria-label={intl.formatMessage(messages.nodePicker)}>
                  <ListBoxItem id="" textValue={intl.formatMessage(messages.allNodes)}>{intl.formatMessage(messages.allNodes)}</ListBoxItem>
                  {nodes.map((node) => (
                    <ListBoxItem key={node.name} id={node.name} textValue={node.name}>{node.name}</ListBoxItem>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            {prometheus && <RangeSelect value={range} onChange={setRange} />}
          </div>
        }
      />

      {live.isPending && <LoadingCard message={intl.formatMessage(messages.loading)} />}
      {live.isError && <ErrorCard message={intl.formatMessage(messages.error)} onRetry={() => void live.refetch()} />}

      {live.data && (
        <>
          <StatisticsNotice source={live.data.source} warnings={live.data.warnings} />

          <section className="space-y-3">
            <LiveStatus updatedAt={Date.parse(live.data.generatedAt)} />
            <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
              <LiveCard
                label={intl.formatMessage(messages.cpu)}
                icon={<Cpu className="size-4" />}
                tone="cpu"
                value={percentText(cpuPct)}
                unit={intl.formatMessage(messages.unitPercent)}
                sub={cluster && cluster.cpu.used !== null ? intl.formatMessage(messages.cpuSub, { used: oneDecimal(cluster.cpu.used), capacity: oneDecimal(cluster.cpu.capacity) }) : undefined}
                delta={trendOf(seriesDelta(cpuSeries), pointsDelta)}
                series={cpuSeries.map(([, value]) => value)}
                formatPoint={oneDecimal}
                peak={peakOf(cpuSeries, (value) => intl.formatMessage(messages.percentValue, { value: oneDecimal(value) }))}
              />
              <LiveCard
                label={intl.formatMessage(messages.memory)}
                icon={<MemoryStick className="size-4" />}
                tone="memory"
                value={percentText(memoryPct)}
                unit={intl.formatMessage(messages.unitPercent)}
                sub={cluster && cluster.memory.used !== null ? intl.formatMessage(messages.memorySub, { used: formatBytes(cluster.memory.used), capacity: formatBytes(cluster.memory.capacity) }) : undefined}
                delta={trendOf(seriesDelta(memorySeries), pointsDelta)}
                series={memorySeries.map(([, value]) => value)}
                formatPoint={oneDecimal}
                peak={peakOf(memorySeries, (value) => intl.formatMessage(messages.percentValue, { value: oneDecimal(value) }))}
              />
              <LiveCard
                label={intl.formatMessage(messages.inbound)}
                icon={<ArrowDownToLine className="size-4" />}
                tone="inbound"
                value={network && network.rx !== null ? mbps(network.rx, format) : null}
                unit={intl.formatMessage(messages.unitMbps)}
                sub={network && network.rx !== null ? intl.formatMessage(messages.networkSub, { rate: formatBits(network.rx), count: nodes.length }) : undefined}
                placeholder={network ? undefined : intl.formatMessage(messages.needsPrometheus)}
                delta={trendOf(percentChange(rxPoints), percentDelta)}
                series={rxPoints.map(([, value]) => value)}
                formatPoint={(value) => mbps(value, format)}
                peak={peakOf(rxPoints, (value) => intl.formatMessage(messages.rateMbps, { value: mbps(value, format) }))}
              />
              <LiveCard
                label={intl.formatMessage(messages.outbound)}
                icon={<ArrowUpFromLine className="size-4" />}
                tone="outbound"
                value={network && network.tx !== null ? mbps(network.tx, format) : null}
                unit={intl.formatMessage(messages.unitMbps)}
                sub={network && network.tx !== null ? intl.formatMessage(messages.networkSub, { rate: formatBits(network.tx), count: nodes.length }) : undefined}
                placeholder={network ? undefined : intl.formatMessage(messages.needsPrometheus)}
                delta={trendOf(percentChange(txPoints), percentDelta)}
                series={txPoints.map(([, value]) => value)}
                formatPoint={(value) => mbps(value, format)}
                peak={peakOf(txPoints, (value) => intl.formatMessage(messages.rateMbps, { value: mbps(value, format) }))}
              />
            </div>
          </section>

          {prometheus && (
            <>
              {history.isError && <ErrorCard message={intl.formatMessage(messages.historyError)} onRetry={() => void history.refetch()} />}
              <div className="grid gap-4 lg:grid-cols-3">
                <NetworkCard history={history.data} pending={history.isPending} range={range} />
                <BandwidthCard nodes={nodes} />
              </div>
              {history.data?.heatmap && <HeatmapCard heatmap={history.data.heatmap} range={range} />}
            </>
          )}

          <NodesCard nodes={nodes} history={history.data} range={range} />
          {prometheus && servers.length > 0 && <ServersCard servers={servers} />}
        </>
      )}
    </div>
  );
}

export function StatisticsNotice({ source, warnings }: { source: StatisticsSource; warnings: StatisticsWarning[] }) {
  const intl = useOptionalIntl();
  const unreachable = warnings.includes("prometheus_unreachable");
  const partial = warnings.includes("prometheus_partial");
  return (
    <>
      {(unreachable || source !== "prometheus") && (
        <Card className="flex flex-col gap-4 border border-accent/30 bg-accent-soft p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
              <ChartLine className="size-4" />
            </span>
            <div className="min-w-0 space-y-1">
              <div className="text-sm font-semibold">{intl.formatMessage(unreachable ? messages.unreachableTitle : messages.connectTitle)}</div>
              <p className="text-xs text-muted">{intl.formatMessage(unreachable ? messages.unreachableBody : messages.connectBody)}</p>
            </div>
          </div>
          <a href={STATISTICS_SETUP_URL} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline" })}>
            {intl.formatMessage(messages.setupGuide)} <ArrowRight className="size-4" />
          </a>
        </Card>
      )}
      {partial && <p className="text-xs text-muted">{intl.formatMessage(messages.partial)}</p>}
    </>
  );
}

export function LiveStatus({ updatedAt }: { updatedAt?: number }) {
  const intl = useOptionalIntl();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <span className={HEADER_CLASS}>{intl.formatMessage(messages.liveUsage)}</span>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success-soft-foreground">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
        {intl.formatMessage(messages.live)}
      </span>
      {updatedAt !== undefined && (
        <span>{intl.formatMessage(messages.liveUpdated, { relative: formatRelative(new Date(updatedAt).toISOString(), intl) })}</span>
      )}
    </div>
  );
}

export function NodeStatusPill({ ready }: { ready: boolean }) {
  const intl = useOptionalIntl();
  return (
    <span className={cn("inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", ready ? "bg-success-soft text-success-soft-foreground" : "bg-danger-soft text-danger-soft-foreground")}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", ready ? "bg-success" : "bg-danger")} />
      {intl.formatMessage(ready ? messages.statusReady : messages.statusNotReady)}
    </span>
  );
}

export function MiniStat({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border p-3">
      <div className="truncate text-[11px] text-muted">{label}</div>
      <div className="mt-1 font-mono text-sm text-foreground">{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export function UsageBar({ share, className }: { share: number; className: string }) {
  const width = Math.min(100, Math.max(0, share));
  return (
    <span className="block h-1.5 overflow-hidden rounded-full bg-border/40">
      <span className={cn("block h-full rounded-full", className)} style={{ width: `${width}%` }} />
    </span>
  );
}

function LiveSparkline({ points }: { points: StatisticsPoint[] }) {
  return <Sparkline data={points.map(([, value]) => value)} className="text-accent" />;
}

function NetworkCard({ history, pending, range }: { history: StatisticsHistory | undefined; pending: boolean; range: StatisticsRange }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const emptyValue = intl.formatMessage(messages.empty);
  const network = history?.network ?? null;
  const inbound = intl.formatMessage(messages.inbound);
  const outbound = intl.formatMessage(messages.outbound);
  const title = intl.formatMessage(messages.networkTitle);
  const peak = network?.peak ?? null;
  const p95 = network?.p95 ?? null;
  const rxTotal = network?.rxTotal ?? null;
  const txTotal = network?.txTotal ?? null;
  return (
    <Card className="min-w-0 gap-3 border border-border bg-card p-4 sm:p-5 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-xs text-muted">{intl.formatMessage(messages.networkSubtitle, { range })}</div>
        </div>
        <ChartLegend
          items={[
            { label: inbound, color: "var(--chart-inbound)" },
            { label: outbound, color: "var(--chart-outbound)" },
          ]}
        />
      </div>
      {pending ? (
        <div className="h-[180px] animate-pulse rounded-md bg-surface" />
      ) : (
        <LineChart
          series={[
            { key: "rx", label: inbound, color: "var(--chart-inbound)", points: network?.rx ?? [], area: true },
            { key: "tx", label: outbound, color: "var(--chart-outbound)", points: network?.tx ?? [], area: true },
          ]}
          range={range}
          unitBase={1e6}
          formatValue={(value) => intl.formatMessage(messages.rateMbps, { value: mbps(value, format) })}
          ariaLabel={title}
        />
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat label={intl.formatMessage(messages.totalIn)} value={rxTotal === null ? emptyValue : formatBytes(rxTotal)} />
        <MiniStat label={intl.formatMessage(messages.totalOut)} value={txTotal === null ? emptyValue : formatBytes(txTotal)} />
        <MiniStat
          label={intl.formatMessage(messages.peak)}
          value={peak === null ? emptyValue : formatRate(peak.value)}
          sub={peak === null ? undefined : formatTick(peak.at, range, intl.locale)}
        />
        <MiniStat label={intl.formatMessage(messages.p95)} value={p95 === null ? emptyValue : formatRate(p95)} />
      </div>
    </Card>
  );
}

function BandwidthCard({ nodes }: { nodes: StatisticsNodeSummary[] }) {
  const intl = useOptionalIntl();
  const title = intl.formatMessage(messages.bandwidthTitle);
  const traffic = (node: StatisticsNodeSummary) => (node.rx ?? 0) + (node.tx ?? 0);
  const rows = [...nodes]
    .sort((a, b) => traffic(b) - traffic(a))
    .map((node) => ({ key: node.name, label: node.name, rx: node.rx, tx: node.tx }));
  return (
    <Card className="min-w-0 gap-3 border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-xs text-muted">{intl.formatMessage(messages.bandwidthSubtitle)}</div>
        </div>
        <ChartLegend
          items={[
            { label: intl.formatMessage(messages.legendIn), color: "var(--chart-inbound)" },
            { label: intl.formatMessage(messages.legendOut), color: "var(--chart-outbound)" },
          ]}
        />
      </div>
      <SplitBars rows={rows} ariaLabel={title} />
    </Card>
  );
}

function HeatmapCard({ heatmap, range }: { heatmap: NonNullable<StatisticsHistory["heatmap"]>; range: StatisticsRange }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const [metric, setMetric] = useState<Metric>("cpu");
  const byNode = heatmap[metric];
  const rows = Object.keys(byNode)
    .sort()
    .map((key) => ({ key, label: key, values: byNode[key] }));
  const observed = rows.flatMap((row) => row.values.filter((value): value is number => value !== null));
  const max = metric === "network" ? Math.max(1, ...observed) : 100;
  const title = intl.formatMessage(messages.heatmapTitle);
  const formatValue = (value: number) =>
    metric === "network" ? formatRate(value) : intl.formatMessage(messages.percentValue, { value: format.number(value, { maximumFractionDigits: 0 }) });
  return (
    <Card className="min-w-0 gap-3 border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-xs text-muted">{intl.formatMessage(messages.heatmapSubtitle, { range })}</div>
        </div>
        <SegmentedControl
          options={METRICS.map((option) => ({ value: option, label: intl.formatMessage(metricMessages[option]) }))}
          value={metric}
          onChange={setMetric}
          ariaLabel={intl.formatMessage(messages.heatmapSwitch)}
        />
      </div>
      <Heatmap
        rows={rows}
        buckets={heatmap.buckets}
        range={range}
        max={max}
        color={HEATMAP_COLOR[metric]}
        formatValue={formatValue}
        legendLabel={intl.formatMessage(metricMessages[metric])}
        ariaLabel={title}
      />
    </Card>
  );
}

function NodesCard({ nodes, history, range }: { nodes: StatisticsNodeSummary[]; history: StatisticsHistory | undefined; range: StatisticsRange }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const cores = nodes.reduce((sum, node) => sum + node.cpuCapacity, 0);
  const memory = nodes.reduce((sum, node) => sum + node.memoryCapacity, 0);
  const columns = [messages.columnNode, messages.columnStatus, messages.columnCpu, messages.columnMemory, messages.columnNetIn, messages.columnNetOut, messages.columnLoad, messages.columnPods, messages.columnTrend];
  return (
    <Card className="min-w-0 gap-3 border border-border bg-card p-4 sm:p-5">
      <div>
        <div className="text-sm font-semibold">{intl.formatMessage(messages.nodesTitle)}</div>
        <div className="text-xs text-muted">
          {intl.formatMessage(messages.nodesSubtitle, { count: nodes.length, cores: format.number(cores), memory: formatBytes(memory) })}
        </div>
      </div>
      <div className="@container flex flex-col gap-3">
        <div className={cn("hidden items-center border-b border-border px-2 pb-2 @5xl:grid @5xl:gap-4", NODE_COLUMNS)}>
          {columns.map((column) => (
            <span key={column.id} className={HEADER_CLASS}>{intl.formatMessage(column, { range })}</span>
          ))}
          <span />
        </div>
        <div className="flex flex-col">
          {nodes.map((node) => (
            <NodeRow key={node.name} node={node} trend={history?.nodeCpu[node.name]} range={range} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function NodeRow({ node, trend, range }: { node: StatisticsNodeSummary; trend: StatisticsPoint[] | undefined; range: StatisticsRange }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const emptyValue = intl.formatMessage(messages.empty);
  const amount = (value: number | null, options?: Intl.NumberFormatOptions) => (value === null ? emptyValue : format.number(value, options));
  const rate = (value: number | null) => (value === null ? emptyValue : formatRate(value));
  const mbpsText = (value: number | null) => (value === null ? emptyValue : mbps(value, format));
  const cpuPct = percent(node.cpuUsed, node.cpuCapacity);
  const memoryPct = percent(node.memoryUsed, node.memoryCapacity);
  const spec = node.internalIP
    ? intl.formatMessage(messages.nodeSpec, { cores: format.number(node.cpuCapacity), memory: formatBytes(node.memoryCapacity), ip: node.internalIP })
    : intl.formatMessage(messages.nodeSpecNoIp, { cores: format.number(node.cpuCapacity), memory: formatBytes(node.memoryCapacity) });
  return (
    <Link
      to="/statistics/nodes/$name"
      params={{ name: node.name }}
      search={{ range }}
      className="block rounded-md px-2 py-3 hover:bg-surface @5xl:py-2.5"
    >
      <span className="flex flex-col gap-2 @5xl:hidden">
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block truncate font-mono text-sm font-semibold text-foreground">{node.name}</span>
            <span className="block truncate text-xs text-muted">{spec}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <NodeStatusPill ready={node.ready} />
            <ChevronRight aria-hidden="true" className="size-4 text-muted" />
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="flex min-w-[8rem] flex-1 items-center gap-2">
            <span className="w-8 shrink-0 text-muted">{intl.formatMessage(messages.mobileCpu)}</span>
            <InlineMeter pct={cpuPct} tone="cpu" />
          </span>
          <span className="flex min-w-[8rem] flex-1 items-center gap-2">
            <span className="w-8 shrink-0 text-muted">{intl.formatMessage(messages.mobileMemory)}</span>
            <InlineMeter pct={memoryPct} tone="memory" />
          </span>
          <span className="font-mono text-foreground">{intl.formatMessage(messages.mobileRates, { rx: mbpsText(node.rx), tx: mbpsText(node.tx) })}</span>
        </span>
      </span>
      <span className={cn("hidden items-center @5xl:grid @5xl:gap-4", NODE_COLUMNS)}>
        <span className="min-w-0">
          <span className="block truncate font-mono text-sm font-semibold text-foreground">{node.name}</span>
          <span className="block truncate text-xs text-muted">{spec}</span>
        </span>
        <NodeStatusPill ready={node.ready} />
        <InlineMeter pct={cpuPct} tone="cpu" />
        <InlineMeter pct={memoryPct} tone="memory" />
        <span className="font-mono text-xs text-foreground">{rate(node.rx)}</span>
        <span className="font-mono text-xs text-foreground">{rate(node.tx)}</span>
        <span className="font-mono text-xs text-foreground">{amount(node.load1, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        <span className="font-mono text-xs text-foreground">{node.pods}</span>
        <span>{trend && trend.length > 1 ? <LiveSparkline points={trend} /> : emptyValue}</span>
        <ChevronRight aria-hidden="true" className="size-4 text-muted" />
      </span>
    </Link>
  );
}

function ServersCard({ servers }: { servers: StatisticsServerSummary[] }) {
  const intl = useOptionalIntl();
  const [metric, setMetric] = useState<Metric>("cpu");
  const sortKey = (server: StatisticsServerSummary) => {
    if (metric === "cpu") return server.cpu ?? -1;
    if (metric === "memory") return server.memory ?? -1;
    return (server.rx ?? 0) + (server.tx ?? 0);
  };
  const rows = [...servers].sort((a, b) => sortKey(b) - sortKey(a)).slice(0, TOP_SERVER_COUNT);
  const columns = [messages.columnServer, messages.columnNode, messages.columnCpu, messages.columnMemory, messages.columnNet, messages.columnPlayers];
  return (
    <Card className="min-w-0 gap-3 border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{intl.formatMessage(messages.serversTitle)}</div>
          <div className="text-xs text-muted">{intl.formatMessage(messages.serversSubtitle)}</div>
        </div>
        <SegmentedControl
          options={METRICS.map((option) => ({ value: option, label: intl.formatMessage(metricMessages[option]) }))}
          value={metric}
          onChange={setMetric}
          ariaLabel={intl.formatMessage(messages.serversSwitch)}
        />
      </div>
      <div className="@container flex flex-col gap-3">
        <div className={cn("hidden items-center border-b border-border px-2 pb-2 @4xl:grid @4xl:gap-4", SERVER_COLUMNS)}>
          {columns.map((column) => (
            <span key={column.id} className={HEADER_CLASS}>{intl.formatMessage(column)}</span>
          ))}
        </div>
        <div className="flex flex-col">
          {rows.map((server) => (
            <ServerRow key={`${server.namespace}/${server.name}`} server={server} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function ServerRow({ server }: { server: StatisticsServerSummary }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const emptyValue = intl.formatMessage(messages.empty);
  const amount = (value: number | null, options?: Intl.NumberFormatOptions) => (value === null ? emptyValue : format.number(value, options));
  const cpuShare = percent(server.cpu, server.cpuLimit ?? 0) ?? 0;
  const memoryShare = percent(server.memory, server.memoryLimit ?? 0) ?? 0;
  const initials = server.name.slice(0, 2).toUpperCase();
  const cpuText = intl.formatMessage(messages.serverCpu, { used: amount(server.cpu, { maximumFractionDigits: 2 }), limit: amount(server.cpuLimit, { maximumFractionDigits: 2 }) });
  const memoryText = intl.formatMessage(messages.serverMemory, { used: server.memory === null ? emptyValue : formatBytes(server.memory), limit: server.memoryLimit === null ? emptyValue : formatBytes(server.memoryLimit) });
  return (
    <Link
      to="/servers/$name"
      params={{ name: server.name }}
      search={{ ns: server.namespace }}
      className="block rounded-md px-2 py-3 hover:bg-surface @4xl:py-2.5"
    >
      <span className="flex items-center justify-between gap-3 @4xl:hidden">
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border font-mono text-[10px] font-semibold text-muted">{initials}</span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-sm font-semibold text-foreground">{server.name}</span>
            <span className="block truncate text-xs text-muted">{server.node ?? emptyValue}</span>
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-mono text-xs text-foreground">{cpuText}</span>
          <span className="block font-mono text-xs text-muted">{memoryText}</span>
        </span>
      </span>
      <span className={cn("hidden items-center @4xl:grid @4xl:gap-4", SERVER_COLUMNS)}>
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border font-mono text-[10px] font-semibold text-muted">{initials}</span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-sm font-semibold text-foreground">{server.name}</span>
            <span className="block truncate text-xs text-muted">{intl.formatMessage(messages.serverScope, { namespace: server.namespace })}</span>
          </span>
        </span>
        <span className="font-mono text-xs text-muted">{server.node ?? emptyValue}</span>
        <span className="min-w-0 space-y-1">
          <span className="block font-mono text-xs text-foreground">{cpuText}</span>
          <UsageBar share={cpuShare} className="bg-accent" />
        </span>
        <span className="min-w-0 space-y-1">
          <span className="block font-mono text-xs text-foreground">{memoryText}</span>
          <UsageBar share={memoryShare} className="bg-chart-stat" />
        </span>
        <span className="font-mono text-xs text-foreground">
          {intl.formatMessage(messages.serverNet, { inbound: server.rx === null ? emptyValue : mbps(server.rx, format), outbound: server.tx === null ? emptyValue : mbps(server.tx, format) })}
        </span>
        <span className="font-mono text-xs text-foreground">
          {intl.formatMessage(messages.serverPlayers, { online: amount(server.players), max: server.maxPlayers === -1 ? intl.formatMessage(messages.unlimited) : amount(server.maxPlayers) })}
        </span>
      </span>
    </Link>
  );
}
