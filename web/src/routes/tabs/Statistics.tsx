import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Card, buttonVariants } from "@heroui/react";
import { ArrowRight } from "lucide-react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { ChartLegend, LineChart, type Threshold } from "@/components/statistics/LineChart";
import { RangeSelect } from "@/components/statistics/RangeSelect";
import { ErrorCard } from "@/components/ui/ErrorCard";
import { LoadingCard } from "@/components/ui/LoadingCard";
import { Statistics } from "@/lib/endpoints";
import { useFormat, useOptionalIntl } from "@/lib/i18n/format";
import { STATISTICS_SETUP_URL } from "@/lib/links";
import { DEFAULT_RANGE, formatByteSize, formatRate, formatTick, percent, seriesPeak } from "@/lib/statistics";
import { cn, formatBytes } from "@/lib/utils";
import { mbps, messages as overview } from "@/routes/Statistics";
import type { ServerStatistics, StatisticsRange, StatisticsWarning } from "@/types";

const CPU_COLOR = "var(--accent)";
const MEMORY_COLOR = "var(--chart-stat)";
const INBOUND_COLOR = "var(--chart-inbound)";
const OUTBOUND_COLOR = "var(--chart-outbound)";
const PLAYERS_COLOR = "var(--chart-players)";
const REQUEST_COLOR = "var(--muted)";
const LIMIT_COLOR = "var(--warning)";
const GIGABYTE = 1024 ** 3;
const MEGABYTE = 1e6;
const DATA_MOUNT = "/data";

const TEXT = defineMessages({
  empty_value: {
    id: "web.common.empty_value",
    defaultMessage: "—",
    description: "Shown in place of a value that is not set",
  },
  load_error: {
    id: "web.routes.tabs.statistics.load_error",
    defaultMessage: "Server statistics could not be loaded.",
    description: "Server statistics tab: error card shown when the server's statistics request fails; a retry button is on the card",
  },
  history: {
    id: "web.routes.tabs.statistics.history",
    defaultMessage: "History",
    description: "Server statistics tab: section label above the history charts; shown in uppercase",
  },
  not_configured_title: {
    id: "web.routes.tabs.statistics.not_configured_title",
    defaultMessage: "Prometheus is not configured",
    description: "Server statistics tab: title of the empty state shown when no Prometheus is set up for this install",
  },
  not_configured_body: {
    id: "web.routes.tabs.statistics.not_configured_body",
    defaultMessage: "Server history comes from Prometheus. Set metrics.prometheus.url in the Helm values to a Prometheus that scrapes node-exporter and cAdvisor. kube-prometheus-stack works as is.",
    description: "Server statistics tab: body of the empty state that explains which Helm value connects Prometheus; metrics.prometheus.url is a setting name, keep it as is",
  },
  unreachable_title: {
    id: "web.routes.tabs.statistics.unreachable_title",
    defaultMessage: "Prometheus is unreachable",
    description: "Server statistics tab: title of the empty state shown when the configured Prometheus does not answer",
  },
  unreachable_body: {
    id: "web.routes.tabs.statistics.unreachable_body",
    defaultMessage: "Gameplane could not query the Prometheus at metrics.prometheus.url. Check the URL and that Prometheus is running.",
    description: "Server statistics tab: body of the empty state shown when the configured Prometheus does not answer; metrics.prometheus.url is a setting name, keep it as is",
  },
  setup_guide: {
    id: "web.routes.tabs.statistics.setup_guide",
    defaultMessage: "Setup guide",
    description: "Server statistics tab: button that opens the Prometheus setup guide in a new tab; keep it short",
  },
  cpu_title: {
    id: "web.routes.tabs.statistics.cpu_title",
    defaultMessage: "CPU usage",
    description: "Server statistics tab: title of the CPU history chart",
  },
  memory_title: {
    id: "web.routes.tabs.statistics.memory_title",
    defaultMessage: "Memory usage",
    description: "Server statistics tab: title of the memory history chart",
  },
  usage: {
    id: "web.routes.tabs.statistics.usage",
    defaultMessage: "Usage",
    description: "Server statistics tab: legend label of the measured usage line in the CPU and memory charts",
  },
  request: {
    id: "web.routes.tabs.statistics.request",
    defaultMessage: "Request",
    description: "Server statistics tab: legend label of the requested-resources line in the CPU and memory charts",
  },
  limit: {
    id: "web.routes.tabs.statistics.limit",
    defaultMessage: "Limit",
    description: "Server statistics tab: legend label of the resource limit line in the CPU and memory charts",
  },
  network_title: {
    id: "web.routes.tabs.statistics.network_title",
    defaultMessage: "Network throughput",
    description: "Server statistics tab: title of the network throughput chart",
  },
  inbound: {
    id: "web.routes.tabs.statistics.inbound",
    defaultMessage: "Inbound",
    description: "Server statistics tab: legend label of the inbound traffic series",
  },
  outbound: {
    id: "web.routes.tabs.statistics.outbound",
    defaultMessage: "Outbound",
    description: "Server statistics tab: legend label of the outbound traffic series",
  },
  in_since_start: {
    id: "web.routes.tabs.statistics.in_since_start",
    defaultMessage: "In since pod start",
    description: "Server statistics tab: label of the box with the total bytes received since the pod started",
  },
  out_since_start: {
    id: "web.routes.tabs.statistics.out_since_start",
    defaultMessage: "Out since pod start",
    description: "Server statistics tab: label of the box with the total bytes sent since the pod started",
  },
  peak: {
    id: "web.routes.tabs.statistics.peak",
    defaultMessage: "Peak",
    description: "Server statistics tab: label of the box with the highest traffic rate in the range",
  },
  p95: {
    id: "web.routes.tabs.statistics.p95",
    defaultMessage: "p95",
    description: "Server statistics tab: label of the box with the 95th percentile traffic rate; statistics term, keep it as is",
  },
  packets: {
    id: "web.routes.tabs.statistics.packets",
    defaultMessage: "Packets in / out",
    description: "Server statistics tab: label of the box with the inbound and outbound packet rates",
  },
  players_title: {
    id: "web.routes.tabs.statistics.players_title",
    defaultMessage: "Players online",
    description: "Server statistics tab: title of the players history chart",
  },
  players: {
    id: "web.routes.tabs.statistics.players",
    defaultMessage: "Players",
    description: "Server statistics tab: legend label of the players series",
  },
  unlimited: {
    id: "web.routes.tabs.statistics.unlimited",
    defaultMessage: "∞",
    description: "Server statistics tab: shown in place of a player capacity when the server has no limit",
  },
  players_empty: {
    id: "web.routes.tabs.statistics.players_empty",
    defaultMessage: "Player history needs Prometheus to scrape the agent (serviceMonitors.enabled).",
    description: "Server statistics tab: empty state of the players chart when the agent's player metric is not scraped; serviceMonitors.enabled is a setting name, keep it as is",
  },
  storage_title: {
    id: "web.routes.tabs.statistics.storage_title",
    defaultMessage: "Storage & health",
    description: "Server statistics tab: title of the card with data volume usage and container health signals",
  },
  storage_subtitle: {
    id: "web.routes.tabs.statistics.storage_subtitle",
    defaultMessage: "Data volume and container signals",
    description: "Server statistics tab: subtitle of the storage and health card",
  },
  disk_io: {
    id: "web.routes.tabs.statistics.disk_io",
    defaultMessage: "Disk I/O",
    description: "Server statistics tab: label of the box with the data volume read and write rates",
  },
  throttled: {
    id: "web.routes.tabs.statistics.throttled",
    defaultMessage: "CPU throttled",
    description: "Server statistics tab: label of the box with the share of time the container was throttled by its CPU limit",
  },
  restarts: {
    id: "web.routes.tabs.statistics.restarts",
    defaultMessage: "Restarts",
    description: "Server statistics tab: label of the box with the number of container restarts",
  },
  oom_kills: {
    id: "web.routes.tabs.statistics.oom_kills",
    defaultMessage: "OOM kills",
    description: "Server statistics tab: label of the box with the number of times the container was killed for running out of memory; OOM is a technical term, keep it as is",
  },
  node: {
    id: "web.routes.tabs.statistics.node",
    defaultMessage: "Node",
    description: "Server statistics tab: label of the box with the name of the node the pod runs on; links to that node",
  },
  storage_note: {
    id: "web.routes.tabs.statistics.storage_note",
    defaultMessage: "Throttling and OOM kills come from cAdvisor; restarts from the pod status.",
    description: "Server statistics tab: footnote under the storage and health card naming where each signal comes from; cAdvisor is a product name, keep it as is",
  },
  growth_gain: {
    id: "web.routes.tabs.statistics.growth_gain",
    defaultMessage: "+{size}",
    description: "Server statistics tab: data volume growth over the range when it grew; {size} is a formatted byte size",
  },
  growth_loss: {
    id: "web.routes.tabs.statistics.growth_loss",
    defaultMessage: "-{size}",
    description: "Server statistics tab: data volume growth over the range when it shrank; {size} is a formatted byte size",
  },
});

function thresholdLine(key: string, label: string, value: number | null, color: string): Threshold[] {
  return value === null ? [] : [{ key, label, value, color, dashed: true }];
}

function ChartCard({ title, subtitle, legend, children }: { title: string; subtitle?: string; legend?: ReactNode; children: ReactNode }) {
  return (
    <Card className="min-w-0 gap-3 border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
        {legend}
      </div>
      {children}
    </Card>
  );
}

function MiniStat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="truncate text-[11px] text-muted">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold text-foreground">{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function EmptyBox({ message }: { message: string }) {
  return (
    <div className="flex h-44 items-center justify-center rounded-md border border-dashed border-border px-4 text-center text-xs text-muted">
      {message}
    </div>
  );
}

function HistoryHeader({ pod, node, range, onRangeChange }: { pod: string; node: string | null; range: StatisticsRange; onRangeChange: (range: StatisticsRange) => void }) {
  const intl = useOptionalIntl();
  const podLine = node === null
    ? intl.formatMessage({ id: "web.routes.tabs.statistics.pod", defaultMessage: "Pod {pod} · from Prometheus", description: "Server statistics tab: line under the history label naming the pod and the Prometheus source, shown when the pod's node is unknown; {pod} is the pod name" }, { pod })
    : intl.formatMessage({ id: "web.routes.tabs.statistics.pod_on_node", defaultMessage: "Pod {pod} on {node} · from Prometheus", description: "Server statistics tab: line under the history label naming the pod, the node it runs on and the Prometheus source; {pod} is the pod name, {node} the node name" }, { pod, node });
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{intl.formatMessage(TEXT.history)}</span>
        <span className="truncate text-xs text-muted">{podLine}</span>
      </div>
      <RangeSelect value={range} onChange={onRangeChange} />
    </div>
  );
}

function CpuCard({ cpu, range }: { cpu: ServerStatistics["cpu"]; range: StatisticsRange }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const title = intl.formatMessage(TEXT.cpu_title);
  const usage = intl.formatMessage(TEXT.usage);
  const thresholds = [
    ...thresholdLine("request", intl.formatMessage(TEXT.request), cpu.request, REQUEST_COLOR),
    ...thresholdLine("limit", intl.formatMessage(TEXT.limit), cpu.limit, LIMIT_COLOR),
  ];
  const subtitle = cpu.limit === null
    ? intl.formatMessage({ id: "web.routes.tabs.statistics.cpu_subtitle_no_limit", defaultMessage: "Cores · last {range} · no limit set", description: "Server statistics tab: subtitle of the CPU chart when the server has no CPU limit; {range} is a range such as 24h" }, { range })
    : intl.formatMessage({ id: "web.routes.tabs.statistics.cpu_subtitle", defaultMessage: "Cores · last {range}", description: "Server statistics tab: subtitle of the CPU chart with its unit and time range; {range} is a range such as 24h" }, { range });
  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      legend={<ChartLegend items={[{ label: usage, color: CPU_COLOR }, ...thresholds]} />}
    >
      <LineChart
        series={[{ key: "usage", label: usage, color: CPU_COLOR, points: cpu.usage, area: true }]}
        thresholds={thresholds}
        range={range}
        formatValue={(value) => format.number(value, { maximumFractionDigits: 2 })}
        ariaLabel={title}
      />
    </ChartCard>
  );
}

function MemoryCard({ memory, range }: { memory: ServerStatistics["memory"]; range: StatisticsRange }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const title = intl.formatMessage(TEXT.memory_title);
  const usage = intl.formatMessage(TEXT.usage);
  const thresholds = [
    ...thresholdLine("request", intl.formatMessage(TEXT.request), memory.request, REQUEST_COLOR),
    ...thresholdLine("limit", intl.formatMessage(TEXT.limit), memory.limit, LIMIT_COLOR),
  ];
  return (
    <ChartCard
      title={title}
      subtitle={intl.formatMessage({ id: "web.routes.tabs.statistics.memory_subtitle", defaultMessage: "GB · last {range}", description: "Server statistics tab: subtitle of the memory chart with its unit and time range; {range} is a range such as 24h" }, { range })}
      legend={<ChartLegend items={[{ label: usage, color: MEMORY_COLOR }, ...thresholds]} />}
    >
      <LineChart
        series={[{ key: "usage", label: usage, color: MEMORY_COLOR, points: memory.usage, area: true }]}
        thresholds={thresholds}
        range={range}
        unitBase={GIGABYTE}
        formatValue={(value) => intl.formatMessage({ id: "web.routes.tabs.statistics.gigabytes", defaultMessage: "{value} GB", description: "Server statistics tab: memory chart axis label; {value} is a number of gigabytes" }, { value: format.number(value / GIGABYTE, { maximumFractionDigits: 1 }) })}
        ariaLabel={title}
      />
    </ChartCard>
  );
}

function NetworkCard({ network, range }: { network: ServerStatistics["network"]; range: StatisticsRange }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const empty = intl.formatMessage(TEXT.empty_value);
  const title = intl.formatMessage(TEXT.network_title);
  const inbound = intl.formatMessage(TEXT.inbound);
  const outbound = intl.formatMessage(TEXT.outbound);
  const compact = (value: number | null) => (value === null ? empty : format.number(value, { notation: "compact", maximumFractionDigits: 1 }));
  const bytesOrEmpty = (value: number | null) => (value === null ? empty : formatBytes(value));
  return (
    <ChartCard
      title={title}
      subtitle={intl.formatMessage({ id: "web.routes.tabs.statistics.network_subtitle", defaultMessage: "Pod interface · last {range}", description: "Server statistics tab: subtitle of the network chart naming the interface and time range; {range} is a range such as 24h" }, { range })}
      legend={<ChartLegend items={[{ label: inbound, color: INBOUND_COLOR }, { label: outbound, color: OUTBOUND_COLOR }]} />}
    >
      <LineChart
        series={[
          { key: "inbound", label: inbound, color: INBOUND_COLOR, points: network.rx, area: true },
          { key: "outbound", label: outbound, color: OUTBOUND_COLOR, points: network.tx, area: true },
        ]}
        range={range}
        unitBase={MEGABYTE}
        formatValue={(value) => intl.formatMessage(overview.rateMbps, { value: mbps(value, format) })}
        height={220}
        ariaLabel={title}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <MiniStat label={intl.formatMessage(TEXT.in_since_start)} value={bytesOrEmpty(network.rxSinceStart)} />
        <MiniStat label={intl.formatMessage(TEXT.out_since_start)} value={bytesOrEmpty(network.txSinceStart)} />
        <MiniStat
          label={intl.formatMessage(TEXT.peak)}
          value={network.peak === null ? empty : formatRate(network.peak.value)}
          sub={network.peak === null ? undefined : formatTick(network.peak.at, range, intl.locale)}
        />
        <MiniStat label={intl.formatMessage(TEXT.p95)} value={network.p95 === null ? empty : formatRate(network.p95)} />
        <MiniStat
          label={intl.formatMessage(TEXT.packets)}
          value={intl.formatMessage({ id: "web.routes.tabs.statistics.packets_value", defaultMessage: "{inbound} / {outbound} /s", description: "Server statistics tab: inbound and outbound packet rates per second; {inbound} and {outbound} are compact numbers" }, { inbound: compact(network.rxPackets), outbound: compact(network.txPackets) })}
        />
      </div>
    </ChartCard>
  );
}

function PlayersCard({ players, range }: { players: ServerStatistics["players"]; range: StatisticsRange }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const title = intl.formatMessage(TEXT.players_title);
  if (!players) {
    return (
      <ChartCard title={title}>
        <EmptyBox message={intl.formatMessage(TEXT.players_empty)} />
      </ChartCard>
    );
  }
  const label = intl.formatMessage(TEXT.players);
  const peak = seriesPeak(players.online);
  const capacity = players.max === null ? null : players.max < 0 ? intl.formatMessage(TEXT.unlimited) : format.number(players.max);
  let subtitle: string | undefined;
  if (peak !== null && capacity !== null) subtitle = intl.formatMessage({ id: "web.routes.tabs.statistics.players_peak_capacity", defaultMessage: "Peak {peak} at {time} · capacity {capacity}", description: "Server statistics tab: subtitle of the players chart with the peak player count, its time and the capacity; {capacity} is a number or ∞" }, { peak: format.number(peak[1], { maximumFractionDigits: 0 }), time: formatTick(peak[0], range, intl.locale), capacity });
  else if (peak !== null) subtitle = intl.formatMessage({ id: "web.routes.tabs.statistics.players_peak", defaultMessage: "Peak {peak} at {time}", description: "Server statistics tab: subtitle of the players chart with the peak player count and its time" }, { peak: format.number(peak[1], { maximumFractionDigits: 0 }), time: formatTick(peak[0], range, intl.locale) });
  else if (capacity !== null) subtitle = intl.formatMessage({ id: "web.routes.tabs.statistics.players_capacity", defaultMessage: "Capacity {capacity}", description: "Server statistics tab: subtitle of the players chart with only the capacity; {capacity} is a number or ∞" }, { capacity });
  return (
    <ChartCard title={title} subtitle={subtitle} legend={<ChartLegend items={[{ label, color: PLAYERS_COLOR }]} />}>
      <LineChart
        series={[{ key: "players", label, color: PLAYERS_COLOR, points: players.online, area: true }]}
        range={range}
        formatValue={(value) => format.number(value, { maximumFractionDigits: 0 })}
        ariaLabel={title}
      />
    </ChartCard>
  );
}

function StorageCard({ disk, health, node, range }: { disk: ServerStatistics["disk"]; health: ServerStatistics["health"]; node: string | null; range: StatisticsRange }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const empty = intl.formatMessage(TEXT.empty_value);
  const diskPercent = disk.total === null ? null : percent(disk.used, disk.total);
  const megabytesPerSecond = (value: number | null) => (value === null ? empty : format.number(value / MEGABYTE, { maximumFractionDigits: 1 }));
  const count = (value: number | null) => (value === null ? empty : format.number(value));
  const growthMessage: MessageDescriptor = disk.growth !== null && disk.growth < 0 ? TEXT.growth_loss : TEXT.growth_gain;
  const growth = disk.growth === null ? empty : intl.formatMessage(growthMessage, { size: formatByteSize(Math.abs(disk.growth)) });
  const usage = diskPercent === null || disk.used === null || disk.total === null
    ? empty
    : intl.formatMessage({ id: "web.routes.tabs.statistics.disk_usage", defaultMessage: "{percent}% · {used} of {total}", description: "Server statistics tab: data volume usage as a percentage and in bytes; {percent} is a whole number, {used} and {total} are formatted sizes" }, { percent: format.number(Math.round(diskPercent)), used: formatBytes(disk.used), total: formatBytes(disk.total) });
  const fillWidth = diskPercent === null ? 0 : Math.min(100, diskPercent);
  const throttled = health.throttledPercent === null
    ? empty
    : intl.formatMessage({ id: "web.routes.tabs.statistics.percent_value", defaultMessage: "{value}%", description: "Server statistics tab: a percentage value in a storage and health box; {value} is the number" }, { value: format.number(health.throttledPercent, { maximumFractionDigits: 1 }) });
  return (
    <ChartCard title={intl.formatMessage(TEXT.storage_title)} subtitle={intl.formatMessage(TEXT.storage_subtitle)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-sm font-semibold text-foreground">{DATA_MOUNT}</span>
        <span className="font-mono text-xs text-muted">{usage}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-border/40">
        <div className={cn("h-full rounded-full", diskPercent !== null && diskPercent >= 80 ? "bg-warning" : "bg-success")} style={{ width: `${fillWidth}%` }} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MiniStat
          label={intl.formatMessage({ id: "web.routes.tabs.statistics.disk_growth", defaultMessage: "Disk growth · {range}", description: "Server statistics tab: label of the box with how much the data volume grew over the range; {range} is a range such as 24h" }, { range })}
          value={growth}
        />
        <MiniStat
          label={intl.formatMessage(TEXT.disk_io)}
          value={disk.read === null && disk.write === null ? empty : intl.formatMessage({ id: "web.routes.tabs.statistics.disk_io_value", defaultMessage: "{read} / {write} MB/s", description: "Server statistics tab: data volume read and write rates in megabytes per second; {read} and {write} are numbers" }, { read: megabytesPerSecond(disk.read), write: megabytesPerSecond(disk.write) })}
        />
        <MiniStat label={intl.formatMessage(TEXT.throttled)} value={throttled} />
        <MiniStat label={intl.formatMessage(TEXT.restarts)} value={count(health.restarts)} />
        <MiniStat label={intl.formatMessage(TEXT.oom_kills)} value={count(health.oomKills)} />
        <MiniStat
          label={intl.formatMessage(TEXT.node)}
          value={node === null ? empty : (
            <Link to="/statistics/nodes/$name" params={{ name: node }} className="inline-flex items-center gap-1.5 text-accent hover:underline">
              {node}
              <ArrowRight aria-hidden="true" className="size-3.5" />
            </Link>
          )}
        />
      </div>
      <p className="text-xs text-muted">{intl.formatMessage(TEXT.storage_note)}</p>
    </ChartCard>
  );
}

function NotConfigured({ warnings }: { warnings: StatisticsWarning[] }) {
  const intl = useOptionalIntl();
  const unreachable = warnings.includes("prometheus_unreachable");
  return (
    <Card className="min-w-0 gap-3 border border-border bg-card p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-foreground">
        {intl.formatMessage(unreachable ? TEXT.unreachable_title : TEXT.not_configured_title)}
      </h2>
      <p className="text-xs text-muted">{intl.formatMessage(unreachable ? TEXT.unreachable_body : TEXT.not_configured_body)}</p>
      <a href={STATISTICS_SETUP_URL} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "outline" }), "w-fit rounded-full")}>
        {intl.formatMessage(TEXT.setup_guide)}
      </a>
    </Card>
  );
}

export function StatisticsTab({ name, ns }: { name: string; ns?: string }) {
  const intl = useOptionalIntl();
  const [range, setRange] = useState<StatisticsRange>(DEFAULT_RANGE);
  const query = useQuery({
    queryKey: ["statistics", "server", ns, name, range],
    queryFn: ({ signal }) => Statistics.server(name, range, ns, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const data = query.data;
  if (!data) {
    return (
      <div className="p-4 sm:p-6">
        {query.isError
          ? <ErrorCard message={intl.formatMessage(TEXT.load_error)} onRetry={() => void query.refetch()} />
          : <LoadingCard />}
      </div>
    );
  }
  if (data.source === "none") {
    return (
      <div className="p-4 sm:p-6">
        <NotConfigured warnings={data.warnings} />
      </div>
    );
  }
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <HistoryHeader pod={data.pod} node={data.node} range={range} onRangeChange={setRange} />
      <div className="grid gap-4 lg:grid-cols-2">
        <CpuCard cpu={data.cpu} range={range} />
        <MemoryCard memory={data.memory} range={range} />
      </div>
      <NetworkCard network={data.network} range={range} />
      <div className="grid gap-4 lg:grid-cols-2">
        <PlayersCard players={data.players} range={range} />
        <StorageCard disk={data.disk} health={data.health} node={data.node} range={range} />
      </div>
    </div>
  );
}
