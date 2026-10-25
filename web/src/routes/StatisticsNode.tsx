import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, Cpu, MemoryStick } from "lucide-react";
import { Card } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { PageHeader } from "@/components/PageHeader";
import { ErrorCard } from "@/components/ui/ErrorCard";
import { LoadingCard } from "@/components/ui/LoadingCard";
import { ChartLegend, LineChart } from "@/components/statistics/LineChart";
import { LiveCard } from "@/components/statistics/LiveCard";
import { RangeSelect } from "@/components/statistics/RangeSelect";
import { APIError } from "@/lib/api";
import { Statistics } from "@/lib/endpoints";
import { useFormat, useOptionalIntl, type FormatApi } from "@/lib/i18n/format";
import { DEFAULT_RANGE, formatBits, formatRate, percent, seriesDelta } from "@/lib/statistics";
import { cn, formatBytes, formatUptime } from "@/lib/utils";
import {
  LiveStatus,
  MiniStat,
  NodeStatusPill,
  StatisticsNotice,
  UsageBar,
  mbps,
  messages as overview,
  peakOf,
  percentChange,
  toPercentSeries,
  trendOf,
} from "@/routes/Statistics";
import type { StatisticsNodeDetail, StatisticsPoint, StatisticsRange, StatisticsServerSummary } from "@/types";

const messages: Record<string, MessageDescriptor> = defineMessages({
  notFound: { id: "web.routes.statistics_node.not_found", defaultMessage: "This node was not found.", description: "Node statistics: error card shown when the node does not exist" },
  back: { id: "web.routes.statistics_node.back", defaultMessage: "Back to statistics", description: "Node statistics: link back to the overview from the not-found state" },
  error: { id: "web.routes.statistics_node.error", defaultMessage: "Couldn't load this node's statistics.", description: "Node statistics: error card message when the node statistics cannot be loaded" },
  loading: { id: "web.routes.statistics_node.loading", defaultMessage: "Loading node statistics…", description: "Node statistics: loading message while the node statistics are fetched" },
  separator: { id: "web.common.separator_dot", defaultMessage: "·", description: "Visual separator between two items" },
  coresValue: { id: "web.routes.statistics_node.cores_value", defaultMessage: "{value} cores", description: "Node statistics: a core count; {value} is the number" },
  kernel: { id: "web.routes.statistics_node.kernel", defaultMessage: "kernel {version}", description: "Node statistics: header detail with the Linux kernel version" },
  uptime: { id: "web.routes.statistics_node.uptime", defaultMessage: "up {uptime}", description: "Node statistics: header detail with how long the node has been running" },
  cpuSub: { id: "web.routes.statistics_node.cpu_sub", defaultMessage: "{used} of {cores} cores · load {load}", description: "Node statistics: CPU card subtitle; {used} and {cores} are core counts and {load} is the one-minute load average" },
  cpuUsage: { id: "web.routes.statistics_node.cpu_usage", defaultMessage: "CPU usage", description: "Node statistics: title of the CPU usage chart" },
  memoryUsage: { id: "web.routes.statistics_node.memory_usage", defaultMessage: "Memory usage", description: "Node statistics: title of the memory usage chart" },
  cpuChartSub: { id: "web.routes.statistics_node.cpu_chart_sub", defaultMessage: "Percent of {cores} cores · last {range}", description: "Node statistics: CPU chart subtitle; {cores} is a core count and {range} the time range" },
  memoryChartSub: { id: "web.routes.statistics_node.memory_chart_sub", defaultMessage: "Percent of {memory} · last {range}", description: "Node statistics: memory chart subtitle; {memory} is a byte size and {range} the time range" },
  usage: { id: "web.routes.statistics_node.usage", defaultMessage: "Usage", description: "Node statistics: legend entry for the measured usage line" },
  requested: { id: "web.routes.statistics_node.requested", defaultMessage: "Requested", description: "Node statistics: legend entry for the dashed line of resources requested by pods on the node" },
  networkSubtitle: { id: "web.routes.statistics_node.network_subtitle", defaultMessage: "All interfaces on this node · last {range}", description: "Node statistics: network chart subtitle; {range} is the selected time range" },
  interfaceColumn: { id: "web.routes.statistics_node.interface_column", defaultMessage: "Interface", description: "Node statistics interfaces table: column with the network interface name" },
  packetsColumn: { id: "web.routes.statistics_node.packets_column", defaultMessage: "Packets in / out", description: "Node statistics interfaces table: column with packets per second received and sent" },
  totalColumn: { id: "web.routes.statistics_node.total_column", defaultMessage: "Total · {range}", description: "Node statistics interfaces table: column with bytes received and sent over the selected range; {range} is the time range" },
  errorsColumn: { id: "web.routes.statistics_node.errors_column", defaultMessage: "Errors / drops", description: "Node statistics interfaces table: column with receive and transmit errors and drops" },
  packetsValue: { id: "web.routes.statistics_node.packets_value", defaultMessage: "{inbound} / {outbound} /s", description: "Node statistics interfaces table: packets per second received and sent; {inbound} and {outbound} are compact counts" },
  totalsValue: { id: "web.routes.statistics_node.totals_value", defaultMessage: "{inbound} / {outbound}", description: "Node statistics interfaces table: bytes received and sent, as two byte sizes separated by a slash" },
  errorsValue: { id: "web.routes.statistics_node.errors_value", defaultMessage: "{errors} / {drops}", description: "Node statistics interfaces table: error and drop counts separated by a slash" },
  system: { id: "web.routes.statistics_node.system", defaultMessage: "System", description: "Node statistics: title of the card with load, disk and filesystem usage" },
  systemSubtitle: { id: "web.routes.statistics_node.system_subtitle", defaultMessage: "Load, disk and filesystems", description: "Node statistics: subtitle of the system card" },
  load1: { id: "web.routes.statistics_node.load_1m", defaultMessage: "Load 1m", description: "Node statistics: mini stat with the one-minute load average" },
  load5: { id: "web.routes.statistics_node.load_5m", defaultMessage: "Load 5m", description: "Node statistics: mini stat with the five-minute load average" },
  load15: { id: "web.routes.statistics_node.load_15m", defaultMessage: "Load 15m", description: "Node statistics: mini stat with the fifteen-minute load average" },
  diskRead: { id: "web.routes.statistics_node.disk_read", defaultMessage: "Disk read", description: "Node statistics: mini stat with the disk read rate" },
  diskWrite: { id: "web.routes.statistics_node.disk_write", defaultMessage: "Disk write", description: "Node statistics: mini stat with the disk write rate" },
  loadNote: { id: "web.routes.statistics_node.load_note", defaultMessage: "Load is per {cores} cores · {percent}% of capacity", description: "Node statistics: note under the load values; {cores} is a core count and {percent} the load as a whole-number share of capacity" },
  filesystems: { id: "web.routes.statistics_node.filesystems", defaultMessage: "Filesystems", description: "Node statistics: section label above the list of filesystems on the node" },
  filesystemMeta: { id: "web.routes.statistics_node.filesystem_meta", defaultMessage: "{device} · {fstype}", description: "Node statistics: muted line under a mount point with the device and filesystem type" },
  filesystemUsage: { id: "web.routes.statistics_node.filesystem_usage", defaultMessage: "{percent}% · {used} of {size}", description: "Node statistics: filesystem usage as a whole-number percentage and the used and total byte sizes" },
  servers: { id: "web.routes.statistics_node.servers", defaultMessage: "Game servers on this node", description: "Node statistics: title of the card listing game servers on this node" },
  serversSubtitle: { id: "web.routes.statistics_node.servers_subtitle", defaultMessage: "{pods} pods · {servers, plural, one {# game server} other {# game servers}}", description: "Node statistics: subtitle of the game servers card with the pod count and the number of game servers" },
  noServers: { id: "web.routes.statistics_node.no_servers", defaultMessage: "No game servers on this node.", description: "Node statistics: text shown when no game server runs on this node" },
  netValue: { id: "web.routes.statistics_node.net_value", defaultMessage: "{inbound} / {outbound} MB/s", description: "Node statistics: game server inbound and outbound rate in MB/s" },
  empty: { id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" },
});

const SERVER_COLUMNS = "@4xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)]";
const HEADER_CLASS = "text-[11px] font-semibold uppercase tracking-wider text-muted";
const CHART_CARD = "min-w-0 gap-3 border border-border bg-card p-4 sm:p-5";

export function StatisticsNodePage() {
  const intl = useOptionalIntl();
  const format = useFormat();
  const navigate = useNavigate();
  const { name } = useParams({ from: "/app-layout/statistics/nodes/$name" });
  const { range: requestedRange } = useSearch({ from: "/app-layout/statistics/nodes/$name" });
  const range = requestedRange ?? DEFAULT_RANGE;
  const detail = useQuery({
    queryKey: ["statistics", "node", name, range],
    queryFn: ({ signal }) => Statistics.node(name, range, signal),
    refetchInterval: 15_000,
    placeholderData: (previous) => (previous?.node.name === name ? previous : undefined),
    retry: (failureCount, error) => !(error instanceof APIError && error.status === 404) && failureCount < 3,
  });
  const data = detail.data;
  const notFound = detail.error instanceof APIError && detail.error.status === 404;
  const setRange = (next: StatisticsRange) => void navigate({ to: "/statistics/nodes/$name", params: { name }, search: { range: next } });

  const subtitle = data ? nodeSubtitle(data, intl, format) : undefined;

  return (
    <div className="min-w-0 space-y-6 p-6">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {name}
            {data && <NodeStatusPill ready={data.node.ready} />}
          </span>
        }
        subtitle={subtitle}
        actions={data?.source === "prometheus" ? <RangeSelect value={range} onChange={setRange} /> : undefined}
      />

      {detail.isPending && <LoadingCard message={intl.formatMessage(messages.loading)} />}
      {notFound && (
        <div className="space-y-3">
          <ErrorCard message={intl.formatMessage(messages.notFound)} />
          <Link to="/statistics" className="text-sm text-accent hover:underline">
            {intl.formatMessage(messages.back)}
          </Link>
        </div>
      )}
      {detail.isError && !notFound && <ErrorCard message={intl.formatMessage(messages.error)} onRetry={() => void detail.refetch()} />}
      {data && <NodeBody data={data} range={range} updatedAt={detail.dataUpdatedAt || undefined} />}
    </div>
  );
}

function nodeSubtitle(data: StatisticsNodeDetail, intl: ReturnType<typeof useOptionalIntl>, format: FormatApi): string {
  const { node } = data;
  const parts = [
    intl.formatMessage(messages.coresValue, { value: format.number(node.cpuCapacity) }),
    formatBytes(node.memoryCapacity),
    node.internalIP,
    node.osImage,
    node.kernelVersion ? intl.formatMessage(messages.kernel, { version: node.kernelVersion }) : undefined,
    node.kubeletVersion,
    node.bootTime === null ? undefined : intl.formatMessage(messages.uptime, { uptime: formatUptime(new Date(node.bootTime * 1000).toISOString(), intl) }),
  ].filter((part): part is string => Boolean(part));
  return parts.join(` ${intl.formatMessage(messages.separator)} `);
}

function NodeBody({ data, range, updatedAt }: { data: StatisticsNodeDetail; range: StatisticsRange; updatedAt: number | undefined }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const emptyValue = intl.formatMessage(messages.empty);
  const { node, live, cpu, memory, network, interfaces, filesystems, servers } = data;
  const prometheus = data.source === "prometheus";
  const oneDecimal = (value: number) => format.number(value, { maximumFractionDigits: 1 });
  const percentLabel = (value: number) => intl.formatMessage(overview.percentValue, { value: format.number(value, { maximumFractionDigits: 1 }) });
  const percentText = (value: number | null) => (value === null ? null : oneDecimal(value));
  const amount = (value: number | null, options?: Intl.NumberFormatOptions) => (value === null ? emptyValue : format.number(value, options));
  const rate = (value: number | null) => (value === null ? emptyValue : formatRate(value));
  const pointsDelta = (value: number) => intl.formatMessage(overview.deltaPoints, { value: oneDecimal(value) });
  const percentDelta = (value: number) => intl.formatMessage(overview.deltaPercent, { value: oneDecimal(value) });

  const cpuPct = percent(node.cpuUsed, node.cpuCapacity);
  const memoryPct = percent(node.memoryUsed, node.memoryCapacity);
  const cpuLive = toPercentSeries(live.cpuSeries, node.cpuCapacity);
  const memoryLive = toPercentSeries(live.memorySeries, node.memoryCapacity);
  const loadPct = percent(node.load1, node.cpuCapacity);

  return (
    <>
      <StatisticsNotice source={data.source} warnings={data.warnings} />

      <section className="space-y-3">
        <LiveStatus updatedAt={updatedAt} />
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <LiveCard
            label={intl.formatMessage(overview.cpu)}
            icon={<Cpu className="size-4" />}
            tone="cpu"
            value={percentText(cpuPct)}
            unit={intl.formatMessage(overview.unitPercent)}
            sub={node.cpuUsed === null ? undefined : intl.formatMessage(messages.cpuSub, { used: oneDecimal(node.cpuUsed), cores: format.number(node.cpuCapacity), load: amount(node.load1, { maximumFractionDigits: 2 }) })}
            delta={trendOf(seriesDelta(cpuLive), pointsDelta)}
            series={cpuLive.map(([, value]) => value)}
            formatPoint={oneDecimal}
            peak={peakOf(cpuLive, percentLabel)}
          />
          <LiveCard
            label={intl.formatMessage(overview.memory)}
            icon={<MemoryStick className="size-4" />}
            tone="memory"
            value={percentText(memoryPct)}
            unit={intl.formatMessage(overview.unitPercent)}
            sub={node.memoryUsed === null ? undefined : intl.formatMessage(overview.memorySub, { used: formatBytes(node.memoryUsed), capacity: formatBytes(node.memoryCapacity) })}
            delta={trendOf(seriesDelta(memoryLive), pointsDelta)}
            series={memoryLive.map(([, value]) => value)}
            formatPoint={oneDecimal}
            peak={peakOf(memoryLive, percentLabel)}
          />
          <LiveCard
            label={intl.formatMessage(overview.inbound)}
            icon={<ArrowDownToLine className="size-4" />}
            tone="inbound"
            value={node.rx === null ? null : mbps(node.rx, format)}
            unit={intl.formatMessage(overview.unitMbps)}
            sub={node.rx === null ? undefined : formatBits(node.rx)}
            placeholder={node.rx === null ? intl.formatMessage(overview.needsPrometheus) : undefined}
            delta={trendOf(percentChange(live.rxSeries), percentDelta)}
            series={live.rxSeries.map(([, value]) => value)}
            formatPoint={(value) => mbps(value, format)}
            peak={peakOf(live.rxSeries, (value) => intl.formatMessage(overview.rateMbps, { value: mbps(value, format) }))}
          />
          <LiveCard
            label={intl.formatMessage(overview.outbound)}
            icon={<ArrowUpFromLine className="size-4" />}
            tone="outbound"
            value={node.tx === null ? null : mbps(node.tx, format)}
            unit={intl.formatMessage(overview.unitMbps)}
            sub={node.tx === null ? undefined : formatBits(node.tx)}
            placeholder={node.tx === null ? intl.formatMessage(overview.needsPrometheus) : undefined}
            delta={trendOf(percentChange(live.txSeries), percentDelta)}
            series={live.txSeries.map(([, value]) => value)}
            formatPoint={(value) => mbps(value, format)}
            peak={peakOf(live.txSeries, (value) => intl.formatMessage(overview.rateMbps, { value: mbps(value, format) }))}
          />
        </div>
      </section>

      {prometheus && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <UsageChartCard
              title={intl.formatMessage(messages.cpuUsage)}
              subtitle={intl.formatMessage(messages.cpuChartSub, { cores: format.number(node.cpuCapacity), range })}
              color="var(--accent)"
              points={toPercentSeries(cpu.usage, node.cpuCapacity)}
              requested={percent(cpu.requested, node.cpuCapacity)}
              range={range}
              formatValue={percentLabel}
            />
            <UsageChartCard
              title={intl.formatMessage(messages.memoryUsage)}
              subtitle={intl.formatMessage(messages.memoryChartSub, { memory: formatBytes(node.memoryCapacity), range })}
              color="var(--chart-stat)"
              points={toPercentSeries(memory.usage, node.memoryCapacity)}
              requested={percent(memory.requested, node.memoryCapacity)}
              range={range}
              formatValue={percentLabel}
            />
          </div>

          <Card className={cn(CHART_CARD, "gap-4")}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold">{intl.formatMessage(overview.networkTitle)}</div>
                <div className="text-xs text-muted">{intl.formatMessage(messages.networkSubtitle, { range })}</div>
              </div>
              <ChartLegend
                items={[
                  { label: intl.formatMessage(overview.inbound), color: "var(--chart-inbound)" },
                  { label: intl.formatMessage(overview.outbound), color: "var(--chart-outbound)" },
                ]}
              />
            </div>
            <LineChart
              series={[
                { key: "rx", label: intl.formatMessage(overview.inbound), color: "var(--chart-inbound)", points: network.rx, area: true },
                { key: "tx", label: intl.formatMessage(overview.outbound), color: "var(--chart-outbound)", points: network.tx, area: true },
              ]}
              range={range}
              unitBase={1e6}
              height={200}
              formatValue={(value) => intl.formatMessage(overview.rateMbps, { value: mbps(value, format) })}
              ariaLabel={intl.formatMessage(overview.networkTitle)}
            />
            <InterfacesTable interfaces={interfaces} range={range} />
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className={cn(CHART_CARD, "gap-4")}>
              <div>
                <div className="text-sm font-semibold">{intl.formatMessage(messages.system)}</div>
                <div className="text-xs text-muted">{intl.formatMessage(messages.systemSubtitle)}</div>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <MiniStat label={intl.formatMessage(messages.load1)} value={amount(node.load1, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
                <MiniStat label={intl.formatMessage(messages.load5)} value={amount(live.load5, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
                <MiniStat label={intl.formatMessage(messages.load15)} value={amount(live.load15, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
                <MiniStat label={intl.formatMessage(messages.diskRead)} value={rate(live.diskRead)} />
                <MiniStat label={intl.formatMessage(messages.diskWrite)} value={rate(live.diskWrite)} />
              </div>
              {loadPct !== null && (
                <p className="text-xs text-muted">
                  {intl.formatMessage(messages.loadNote, { cores: format.number(node.cpuCapacity), percent: format.number(Math.round(loadPct)) })}
                </p>
              )}
              {filesystems.length > 0 && (
                <div className="space-y-3">
                  <div className={HEADER_CLASS}>{intl.formatMessage(messages.filesystems)}</div>
                  {filesystems.map((filesystem) => {
                    const share = percent(filesystem.used, filesystem.size) ?? 0;
                    return (
                      <div key={filesystem.mountpoint} className="space-y-1.5">
                        <div className="flex items-baseline justify-between gap-3 text-xs">
                          <span className="flex min-w-0 items-baseline gap-1.5 truncate">
                            <span className="font-mono text-foreground">{filesystem.mountpoint}</span>
                            <span className="truncate text-muted">{intl.formatMessage(messages.filesystemMeta, { device: filesystem.device, fstype: filesystem.fstype })}</span>
                          </span>
                          <span className="shrink-0 font-mono text-muted">
                            {intl.formatMessage(messages.filesystemUsage, { percent: format.number(Math.round(share)), used: formatBytes(filesystem.used), size: formatBytes(filesystem.size) })}
                          </span>
                        </div>
                        <UsageBar share={share} className={share >= 80 ? "bg-warning" : "bg-success"} />
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card className={cn(CHART_CARD, "gap-4")}>
              <div>
                <div className="text-sm font-semibold">{intl.formatMessage(messages.servers)}</div>
                <div className="text-xs text-muted">{intl.formatMessage(messages.serversSubtitle, { pods: node.pods, servers: servers.length })}</div>
              </div>
              {servers.length === 0 ? (
                <p className="text-sm text-muted">{intl.formatMessage(messages.noServers)}</p>
              ) : (
                <div className="@container flex flex-col">
                  <div className={cn("hidden items-center gap-3 border-b border-border px-2 pb-2 @4xl:grid", SERVER_COLUMNS)}>
                    <span className={HEADER_CLASS}>{intl.formatMessage(overview.columnServer)}</span>
                    <span className={HEADER_CLASS}>{intl.formatMessage(overview.columnCpu)}</span>
                    <span className={HEADER_CLASS}>{intl.formatMessage(overview.columnMemory)}</span>
                    <span className={HEADER_CLASS}>{intl.formatMessage(overview.columnNet)}</span>
                  </div>
                  {servers.map((server) => (
                    <NodeServerRow key={`${server.namespace}/${server.name}`} server={server} />
                  ))}
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function UsageChartCard({
  title,
  subtitle,
  color,
  points,
  requested,
  range,
  formatValue,
}: {
  title: string;
  subtitle: string;
  color: string;
  points: StatisticsPoint[];
  requested: number | null;
  range: StatisticsRange;
  formatValue: (value: number) => string;
}) {
  const intl = useOptionalIntl();
  const usage = intl.formatMessage(messages.usage);
  const requestedLabel = intl.formatMessage(messages.requested);
  return (
    <Card className={CHART_CARD}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-xs text-muted">{subtitle}</div>
        </div>
        <ChartLegend
          items={[
            { label: usage, color },
            { label: requestedLabel, color: "var(--muted)", dashed: true },
          ]}
        />
      </div>
      <LineChart
        series={[{ key: "usage", label: usage, color, points, area: true }]}
        thresholds={requested === null ? [] : [{ key: "requested", label: requestedLabel, value: requested, color: "var(--muted)", dashed: true }]}
        range={range}
        formatValue={formatValue}
        ariaLabel={title}
      />
    </Card>
  );
}

function InterfacesTable({ interfaces, range }: { interfaces: StatisticsNodeDetail["interfaces"]; range: StatisticsRange }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const emptyValue = intl.formatMessage(messages.empty);
  const amount = (value: number | null) => (value === null ? emptyValue : format.number(value, { notation: "compact" }));
  const bytes = (value: number | null) => (value === null ? emptyValue : formatBytes(value));
  const headers = [
    intl.formatMessage(messages.interfaceColumn),
    intl.formatMessage(overview.inbound),
    intl.formatMessage(overview.outbound),
    intl.formatMessage(messages.packetsColumn),
    intl.formatMessage(messages.totalColumn, { range }),
    intl.formatMessage(messages.errorsColumn),
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-border">
            {headers.map((header) => (
              <th key={header} scope="col" className={cn("pb-2 pr-4 font-normal", HEADER_CLASS)}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {interfaces.map((item) => {
            const problem = (item.errors ?? 0) > 0 || (item.drops ?? 0) > 0;
            return (
              <tr key={item.name} className="border-b border-border last:border-0">
                <td className="py-2.5 pr-4 font-mono text-foreground">{item.name}</td>
                <td className="py-2.5 pr-4 font-mono text-xs text-foreground">{item.rx === null ? emptyValue : formatRate(item.rx)}</td>
                <td className="py-2.5 pr-4 font-mono text-xs text-foreground">{item.tx === null ? emptyValue : formatRate(item.tx)}</td>
                <td className="py-2.5 pr-4 font-mono text-xs text-foreground">
                  {intl.formatMessage(messages.packetsValue, { inbound: amount(item.rxPackets), outbound: amount(item.txPackets) })}
                </td>
                <td className="py-2.5 pr-4 font-mono text-xs text-foreground">
                  {intl.formatMessage(messages.totalsValue, { inbound: bytes(item.rxTotal), outbound: bytes(item.txTotal) })}
                </td>
                <td className={cn("py-2.5 pr-4 font-mono text-xs", problem ? "text-warning" : "text-foreground")}>
                  {intl.formatMessage(messages.errorsValue, { errors: amount(item.errors), drops: amount(item.drops) })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function NodeServerRow({ server }: { server: StatisticsServerSummary }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const emptyValue = intl.formatMessage(messages.empty);
  const cores = server.cpu === null ? emptyValue : intl.formatMessage(messages.coresValue, { value: format.number(server.cpu, { maximumFractionDigits: 2 }) });
  const memory = server.memory === null ? emptyValue : formatBytes(server.memory);
  return (
    <Link
      to="/servers/$name"
      params={{ name: server.name }}
      search={{ ns: server.namespace }}
      className="block rounded-md px-2 py-2.5 hover:bg-surface"
    >
      <span className="flex items-center justify-between gap-3 @4xl:hidden">
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border font-mono text-[10px] font-semibold text-muted">
            {server.name.slice(0, 2).toUpperCase()}
          </span>
          <span className="truncate font-mono text-sm font-semibold text-foreground">{server.name}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-mono text-xs text-foreground">{cores}</span>
          <span className="block font-mono text-xs text-muted">{memory}</span>
        </span>
      </span>
      <span className={cn("hidden items-center @4xl:grid @4xl:gap-3", SERVER_COLUMNS)}>
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border font-mono text-[10px] font-semibold text-muted">
            {server.name.slice(0, 2).toUpperCase()}
          </span>
          <span className="truncate font-mono text-sm font-semibold text-foreground">{server.name}</span>
        </span>
        <span className="font-mono text-xs text-foreground">{cores}</span>
        <span className="font-mono text-xs text-foreground">{memory}</span>
        <span className="font-mono text-xs text-foreground">
          {intl.formatMessage(messages.netValue, {
            inbound: server.rx === null ? emptyValue : mbps(server.rx, format),
            outbound: server.tx === null ? emptyValue : mbps(server.tx, format),
          })}
        </span>
      </span>
    </Link>
  );
}
