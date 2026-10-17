import { useResourceClient, useResourceTarget, resourceKey } from "@/lib/resourceTarget";
import { useEffect, useState, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownUp, Copy, Cpu, HardDrive, HeartPulse, MemoryStick, AlertCircle, ServerCog } from "lucide-react";
import type { GameServer, GameTemplate, PlayersResp } from "@/types";

import { Card, CardHeader, CardContent, Alert } from "@heroui/react";
import { Sparkline } from "@/components/ui/Sparkline";
import { ServerActionsCard } from "@/components/server/ServerActionsCard";
import { ServerStatusCard } from "@/components/server/ServerStatusCard";
import { ServerSleepCard } from "@/components/server/ServerSleepCard";
import { EventList } from "@/components/server/EventList";
import { formatBytes, formatCpuPercent, formatRelative, formatUptime, parseQuantityToBytes } from "@/lib/utils";
import { parseCpuQuantity } from "@/lib/quantity";
import { mapServerEvent, type NormalizedServerEvent } from "@/lib/events";
import { playerRows } from "@/lib/players";
import { useOptionalIntl } from "@/lib/i18n/format";
import { conditionMessageText } from "@/lib/i18n/conditionMessage";
import { defineMessages } from "react-intl";

const OVERVIEW_TEXT = defineMessages({
  empty_value: { id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" },
});

export function OverviewTab({
  gs,
  name,
  tmpl,
  ns,
  onViewAllEvents,
  onOpenConsole,
}: {
  gs?: GameServer;
  name: string;
  tmpl?: GameTemplate;
  ns?: string;
  onViewAllEvents?: () => void;
  onOpenConsole?: () => void;
}) {
  const intl = useOptionalIntl();
  const resourceTarget = useResourceTarget({ name, namespace: ns });
  const resourceClient = useResourceClient(resourceTarget);
  const { data: roster } = useQuery({
    queryKey: resourceKey(resourceTarget, "players", name, "overview", ns),
    queryFn: ({ signal }) => resourceClient.withSignal(signal).Players.snapshot(name, ns),
    enabled: !!name && (gs?.status?.phase === "Running"),
    refetchInterval: 10_000,
    retry: false,
  });

  // Kubernetes events for the pod/StatefulSet/GameServer — image pull,
  // scheduling, crash-loops. Poll faster while not Running so provisioning
  // diagnostics stay fresh; back off once the server is up.
  const { data: rawEvents } = useQuery({
    queryKey: resourceKey(resourceTarget, "events", name, ns),
    queryFn: ({ signal }) => resourceClient.withSignal(signal).Servers.events(name, ns),
    enabled: !!name,
    refetchInterval: gs?.status?.phase === "Running" ? 30_000 : 5_000,
    retry: false,
  });

  // ⚡ Bolt: Memoize raw events mapping to prevent unnecessary array recreation
  // Expected impact: Eliminates O(N) mapping on every render cycle when polling
  const events: NormalizedServerEvent[] = useMemo(() => {
    return (Array.isArray(rawEvents) ? rawEvents : []).map(mapServerEvent);
  }, [rawEvents]);

  if (!gs) return <div className="p-6 text-muted">{intl.formatMessage({ id: "web.routes.tabs.overview.loading", defaultMessage: "Loading…", description: "Overview tab: loading text shown until the server status is available" })}</div>;

  const status = gs.status ?? {};
  const running = status.phase === "Running";
  const agent = status.agent;
  // Resource usage comes from the agent's heartbeat (cgroup + statfs).
  // null/undefined means "unknown" (unreadable source, or a stale
  // heartbeat the API blanked) — render "—", not a misleading 0.
  const cpuKnown = typeof agent?.cpuMillicores === "number";
  const cpuMilli = cpuKnown ? (agent?.cpuMillicores as number) : 0;
  const cpuLimitMilli =
    typeof agent?.cpuLimitMillicores === "number" ? (agent?.cpuLimitMillicores as number) : 0;
  const cpuPct = cpuKnown && cpuLimitMilli ? (cpuMilli / cpuLimitMilli) * 100 : 0;

  const memKnown = typeof agent?.memoryBytes === "number";
  const memUsed = memKnown ? (agent?.memoryBytes as number) : 0;
  const memLimit =
    typeof agent?.memoryLimitBytes === "number" ? (agent?.memoryLimitBytes as number) : 0;
  const memPct = memKnown && memLimit ? (memUsed / memLimit) * 100 : 0;

  const diskKnown =
    typeof agent?.diskUsedBytes === "number" && typeof agent?.diskTotalBytes === "number";
  const diskUsed = diskKnown ? (agent?.diskUsedBytes as number) : 0;
  const diskTotal = diskKnown ? (agent?.diskTotalBytes as number) : 0;
  const diskPct = diskKnown && diskTotal ? (diskUsed / diskTotal) * 100 : 0;

  const netRateKnown =
    typeof agent?.networkRxBytesPerSec === "number" && typeof agent?.networkTxBytesPerSec === "number";
  const netRxRate = netRateKnown ? (agent?.networkRxBytesPerSec as number) : 0;
  const netTxRate = netRateKnown ? (agent?.networkTxBytesPerSec as number) : 0;
  const netTotalKnown =
    typeof agent?.networkRxBytes === "number" && typeof agent?.networkTxBytes === "number";
  const netRxTotal = netTotalKnown ? (agent?.networkRxBytes as number) : 0;
  const netTxTotal = netTotalKnown ? (agent?.networkTxBytes as number) : 0;

  const resources = gs.spec.resources ?? tmpl?.spec.resources;
  const cpuRequestCores = cpuCores(resources?.requests?.cpu);
  const cpuLimitCores = cpuCores(resources?.limits?.cpu) ?? (cpuLimitMilli ? cpuLimitMilli / 1000 : undefined);
  const memoryRequest = memoryBytes(resources?.requests?.memory);
  const memoryLimit = memoryBytes(resources?.limits?.memory) ?? (memLimit || undefined);

  // Player count is shown in the Players card (sidebar). null/undefined
  // means "unknown" (RCON unavailable or a stale heartbeat the API
  // blanked); fall back to 0 for the card's header.
  const players =
    typeof agent?.playersOnline === "number" && agent.playersOnline >= 0
      ? (agent.playersOnline as number)
      : 0;
  const endpoints = status.endpoints ?? [];
  const primary = endpoints[0];
  // The operator prepends tunnel endpoints ahead of the cluster-native ones
  // (see gameserver_status.go), so when a tunnel is active `endpoints[0]` is
  // the tunnel endpoint — the cluster address is the first entry after it
  // that isn't itself tunnel-provided.
  const clusterEndpoint = primary?.tunnelProvider
    ? endpoints.find((e) => !e.tunnelProvider)
    : primary;
  const tunnelReady = status.conditions?.find((c) => c.type === "TunnelReady");

  // Check for provisioning failures
  const provisioningFailure = status.conditions?.find(
    (c) => c.reason?.includes("Provisioning") || c.reason?.includes("Storage") || c.reason?.includes("PVC")
  );

  return (
    <div className="space-y-5 p-8">
      {/* Provisioning failure alert */}
      {provisioningFailure && (
        <Alert
          status="warning"
          className="flex items-start gap-3"
        >
          <Alert.Indicator className="mt-0.5">
            <AlertCircle className="h-5 w-5 shrink-0 text-warning" />
          </Alert.Indicator>
          <Alert.Content className="flex flex-1 flex-col gap-1">
            <Alert.Title className="font-semibold text-sm">{intl.formatMessage({ id: "web.routes.tabs.overview.waiting_on_storage_the_server_can_t", defaultMessage: "Waiting on storage — the server can't provision yet", description: "Overview tab: title of the alert shown while the server waits for storage before it can be created; the line below gives the ready condition" })}</Alert.Title>
            <Alert.Description className="text-sm">{intl.formatMessage({ id: "web.routes.tabs.overview.ready_condition_reason_message", defaultMessage: "Ready condition: {reason} — {message}", description: "Overview: alert text for the Ready condition; {reason} is the condition reason and {message} the condition message" }, { reason: provisioningFailure.reason, message: conditionMessageText(intl, provisioningFailure, status.conditionArgs) })}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-4">
            <ResourceCard
              label={intl.formatMessage({ id: "web.routes.tabs.overview.cpu", defaultMessage: "CPU", description: "Overview tab: label of the CPU usage card; technical term, usually left untranslated" })}
              icon={<Cpu className="h-4 w-4" />}
              value={
                cpuKnown ? (cpuLimitMilli ? `${cpuPct.toFixed(0)}%` : formatCpuPercent(cpuMilli / 1000)) : intl.formatMessage(OVERVIEW_TEXT.empty_value)
              }
              sub={
                cpuKnown && cpuLimitMilli
                  ? `${formatCpuPercent(cpuMilli / 1000)} / ${formatCpuPercent(cpuLimitMilli / 1000)}`
                  : undefined
              }
              progress={cpuKnown && cpuLimitMilli ? cpuPct : undefined}
              trend={cpuKnown ? (cpuLimitMilli ? cpuPct : cpuMilli) : undefined}
              accent="primary"
            />
            <ResourceCard
              label={intl.formatMessage({ id: "web.routes.tabs.overview.memory", defaultMessage: "Memory", description: "Overview tab: label of the memory usage card" })}
              icon={<MemoryStick className="h-4 w-4" />}
              value={memKnown ? (memLimit ? `${memPct.toFixed(0)}%` : formatBytes(memUsed)) : intl.formatMessage(OVERVIEW_TEXT.empty_value)}
              sub={
                memKnown ? intl.formatMessage({ id: "web.routes.tabs.overview.used_of_total", defaultMessage: "{used} / {total}", description: "Overview: memory or disk usage against its limit; {used} is the amount in use, {total} the limit" }, { used: formatBytes(memUsed), total: memLimit ? formatBytes(memLimit) : intl.formatMessage(OVERVIEW_TEXT.empty_value) }) : undefined
              }
              progress={memKnown && memLimit ? memPct : undefined}
              trend={memKnown && memLimit ? memPct : undefined}
              accent="violet"
            />
            <ResourceCard
              label={intl.formatMessage({ id: "web.routes.tabs.overview.disk", defaultMessage: "Disk", description: "Overview tab: label of the disk usage card" })}
              icon={<HardDrive className="h-4 w-4" />}
              value={diskKnown ? (diskTotal ? `${diskPct.toFixed(0)}%` : formatBytes(diskUsed)) : intl.formatMessage(OVERVIEW_TEXT.empty_value)}
              sub={
                diskKnown ? intl.formatMessage({ id: "web.routes.tabs.overview.used_of_total", defaultMessage: "{used} / {total}", description: "Overview: memory or disk usage against its limit; {used} is the amount in use, {total} the limit" }, { used: formatBytes(diskUsed), total: diskTotal ? formatBytes(diskTotal) : intl.formatMessage(OVERVIEW_TEXT.empty_value) }) : undefined
              }
              progress={diskKnown && diskTotal ? diskPct : undefined}
              trend={diskKnown && diskTotal ? diskPct : undefined}
              accent="success"
            />
            <ResourceCard
              label={intl.formatMessage({ id: "web.routes.tabs.overview.network", defaultMessage: "Network", description: "Overview tab: label of the network traffic card, showing the inbound and outbound rate" })}
              icon={<ArrowDownUp className="h-4 w-4" />}
              value={netRateKnown ? `${formatBytes(netRxRate + netTxRate)}/s` : intl.formatMessage(OVERVIEW_TEXT.empty_value)}
              sub={
                netRateKnown || netTotalKnown ? (
                  <>
                    {netRateKnown && <div>{intl.formatMessage({ id: "web.routes.tabs.overview.network_rate", defaultMessage: "In {rx}/s · Out {tx}/s", description: "Overview: network card line with the current inbound and outbound rate; {rx} and {tx} are formatted byte amounts per second" }, { rx: formatBytes(netRxRate), tx: formatBytes(netTxRate) })}</div>}
                    {netTotalKnown && (
                      <div>{intl.formatMessage({ id: "web.routes.tabs.overview.network_since_pod_start", defaultMessage: "Since pod start: {rx} in · {tx} out", description: "Overview: network card line with the total bytes received and sent since the pod started; {rx} and {tx} are formatted byte amounts" }, { rx: formatBytes(netRxTotal), tx: formatBytes(netTxTotal) })}</div>
                    )}
                  </>
                ) : undefined
              }
              trend={netRateKnown ? netRxRate + netTxRate : undefined}
              accent="warning"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <AllocationCard
              label={intl.formatMessage({ id: "web.routes.tabs.overview.cpu_allocation", defaultMessage: "CPU allocation", description: "Overview tab: label of the CPU allocation card, comparing the CPU request and limit with the usage" })}
              icon={<Cpu className="h-4 w-4" />}
              used={cpuKnown ? cpuMilli / 1000 : undefined}
              request={cpuRequestCores}
              limit={cpuLimitCores}
              format={formatCpuPercent}
              accent="bg-accent"
            />
            <AllocationCard
              label={intl.formatMessage({ id: "web.routes.tabs.overview.memory_allocation", defaultMessage: "Memory allocation", description: "Overview tab: label of the memory allocation card, comparing the memory request and limit with the usage" })}
              icon={<MemoryStick className="h-4 w-4" />}
              used={memKnown ? memUsed : undefined}
              request={memoryRequest}
              limit={memoryLimit}
              format={formatBytes}
              accent="bg-violet"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <DetailsCard
              label={intl.formatMessage({ id: "web.routes.tabs.overview.server_details", defaultMessage: "Server details", description: "Overview tab: label of the card listing the server's template, version, uptime and exposure" })}
              icon={<ServerCog className="h-4 w-4" />}
              rows={[
                [intl.formatMessage({ id: "web.routes.tabs.overview.template", defaultMessage: "Template", description: "Overview: server details row label for the game template the server was created from" }), tmpl?.spec.displayName ?? gs.spec.templateRef.name],
                [intl.formatMessage({ id: "web.routes.tabs.overview.game_version", defaultMessage: "Game version", description: "Overview: server details row label for the game version the server runs" }), agent?.gameVersion ?? gs.spec.version ?? tmpl?.spec.version ?? intl.formatMessage(OVERVIEW_TEXT.empty_value)],
                [intl.formatMessage({ id: "web.routes.tabs.overview.uptime", defaultMessage: "Uptime", description: "Overview: server details row label for how long the server has been running" }), running ? formatUptime(status.startedAt, intl) : intl.formatMessage(OVERVIEW_TEXT.empty_value)],
                [intl.formatMessage({ id: "web.routes.tabs.overview.capacity", defaultMessage: "Capacity", description: "Overview: server details row label for the players online out of the player slots" }), agent?.playersMax ? `${players} / ${agent.playersMax}` : intl.formatMessage(OVERVIEW_TEXT.empty_value)],
                [intl.formatMessage({ id: "web.routes.tabs.overview.exposure", defaultMessage: "Exposure", description: "Overview: server details row label for how the server is exposed on the network" }), gs.spec.networking?.expose ?? "ClusterIP"],
                [intl.formatMessage({ id: "web.routes.tabs.overview.stop_grace", defaultMessage: "Stop grace", description: "Overview: server details row label for the seconds the server is given to stop gracefully" }), `${gs.spec.stopGracePeriodSeconds ?? 30}s`],
              ]}
            />
            <DetailsCard
              label={intl.formatMessage({ id: "web.routes.tabs.overview.health", defaultMessage: "Health", description: "Overview tab: label of the card listing the server's conditions and its heartbeat and backup times" })}
              icon={<HeartPulse className="h-4 w-4" />}
              rows={[
                ...(status.conditions ?? []).map((condition) => conditionRow(condition, conditionMessageText(intl, condition, status.conditionArgs))),
                [intl.formatMessage({ id: "web.routes.tabs.overview.last_heartbeat", defaultMessage: "Last heartbeat", description: "Overview: health row label for when the agent last reported in" }), agent?.stale ? intl.formatMessage({ id: "web.routes.tabs.overview.heartbeat_stale", defaultMessage: "{time} · stale", description: "Overview: last heartbeat time with a stale marker when the agent has stopped reporting; {time} is a relative time such as 5m ago" }, { time: formatRelative(agent?.lastHeartbeat, intl) }) : formatRelative(agent?.lastHeartbeat, intl)],
                [intl.formatMessage({ id: "web.routes.tabs.overview.last_backup", defaultMessage: "Last backup", description: "Overview: health row label for when the last backup ran" }), formatRelative(status.lastBackupTime, intl)],
                [intl.formatMessage({ id: "web.routes.tabs.overview.agent", defaultMessage: "Agent", description: "Overview: health row label for the version of the agent running in the server pod" }), agent?.version ?? intl.formatMessage(OVERVIEW_TEXT.empty_value)],
              ]}
            />
          </div>

          <Card className="border border-border bg-card p-0">
            <CardHeader className="flex flex-col gap-0 border-b border-border px-6 pb-5 pt-5">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-[1px] text-muted">{intl.formatMessage({ id: "web.routes.tabs.overview.recent_events", defaultMessage: "Recent events", description: "Overview tab: small uppercase heading of the recent events card" })}</h3>
                <button
                  className="text-xs text-accent hover:underline"
                  onClick={onViewAllEvents}
                >{intl.formatMessage({ id: "web.routes.tabs.overview.view_all", defaultMessage: "View all", description: "Overview tab: link-style button in the recent events heading that opens the full events list; keep it short" })}</button>
              </div>
            </CardHeader>
            <CardContent className="px-0">
              <EventList
                events={events}
                emptyMessage={intl.formatMessage({ id: "web.routes.tabs.overview.no_events_yet_lifecycle_backup_and", defaultMessage: "No events yet. Lifecycle, backup, and agent activity will appear here.", description: "Overview tab: empty-state text in the recent events card shown when there are no events yet" })}
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <ServerSleepCard gs={gs} />

          <Card className="border border-border bg-card p-0">
            <CardHeader className="px-6 pb-3 pt-5">
              <h3 className="text-[11px] font-semibold uppercase tracking-[1px] text-muted">{intl.formatMessage({ id: "web.routes.tabs.overview.connection", defaultMessage: "Connection", description: "Overview tab: small uppercase heading of the connection card that lists the server's addresses" })}</h3>
            </CardHeader>
            <CardContent className="space-y-3 px-6 pb-5 text-[13px]">
              {/* Tunnel row — only when a tunnel endpoint actually exists;
                  per design (EZFW0) this row doesn't appear at all otherwise. */}
              {primary?.tunnelProvider && (
                <EndpointRow label={intl.formatMessage({ id: "web.routes.tabs.overview.tunnel", defaultMessage: "Tunnel", description: "Overview tab: label of the tunnel address row, shown only when a tunnel endpoint exists" })}>
                  {primary.host ? (
                    <>
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span
                          className="truncate font-mono text-foreground"
                          title={primary.host + (primary.port !== undefined ? intl.formatMessage({ id: "web.routes.tabs.overview.host_port_suffix", defaultMessage: ":{port}", description: "Overview: port shown after the host of an endpoint; {port} is the port number" }, { port: String(primary.port) }) : "")}
                        >
                          {primary.host}
                          {primary.port !== undefined ? intl.formatMessage({ id: "web.routes.tabs.overview.host_port_suffix", defaultMessage: ":{port}", description: "Overview: port shown after the host of an endpoint; {port} is the port number" }, { port: String(primary.port) }) : ""}
                        </span>
                        {primary.private && (
                          <span className="shrink-0 rounded-full bg-warning/20 px-2 py-0.5 text-[10px] font-medium text-warning">{intl.formatMessage({ id: "web.routes.tabs.overview.tailnet_only", defaultMessage: "Tailnet only", description: "Overview tab: warning badge beside a tunnel address meaning it is reachable only inside the tailnet; keep it short" })}</span>
                        )}
                      </div>
                      <button
                        className="rounded p-1 text-muted hover:bg-border hover:text-foreground"
                        onClick={() => navigator.clipboard?.writeText(primary.host)}
                        title={intl.formatMessage({ id: "web.routes.tabs.overview.copy", defaultMessage: "Copy", description: "Overview tab: icon-only button tooltip that copies the address to the clipboard; keep it short" })}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <span className="text-muted italic">
                      {conditionMessageText(intl, tunnelReady, status.conditionArgs) ?? intl.formatMessage({ id: "web.routes.tabs.overview.waiting_for_tunnel_address", defaultMessage: "Waiting for tunnel address…", description: "Overview: endpoint text shown while the tunnel has not yet published an address" })}
                    </span>
                  )}
                </EndpointRow>
              )}

              {/* External Address row — bare host, no port; a "pool: <name>"
                  annotation underneath when the address was allocated from a
                  pool (EZFW0: "Address 172.18.255.203" / "pool: pool-us-west"). */}
              <EndpointRow label={intl.formatMessage({ id: "web.routes.tabs.overview.external_address", defaultMessage: "External Address", description: "Overview tab: label of the row with the public address of the server, shown without a port" })}>
                {primary?.host ? (
                  <>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-mono text-foreground" title={primary.host}>{primary.host}</span>
                      {primary.pool && (
                        <span className="text-xs text-muted">{intl.formatMessage({ id: "web.routes.tabs.overview.pool_pool", defaultMessage: "pool: {pool}", description: "Overview: load balancer address pool line; {pool} is the pool name" }, { pool: primary.pool })}</span>
                      )}
                    </div>
                    <button
                      className="rounded p-1 text-muted hover:bg-border hover:text-foreground"
                      onClick={() => navigator.clipboard?.writeText(primary.host)}
                      title={intl.formatMessage({ id: "web.routes.tabs.overview.copy", defaultMessage: "Copy", description: "Overview tab: icon-only button tooltip that copies the address to the clipboard; keep it short" })}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <span className="text-muted italic">{intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" })}</span>
                )}
              </EndpointRow>

              {/* Cluster Address — separate Host/Port fields (EZFW0). Omitted
                  entirely when clusterEndpoint resolves to the same endpoint
                  object as primary (no tunnel present): re-showing the
                  External Address's own host/port under a second label would
                  just repeat it, and there is no separate cluster-internal
                  service address in status to fall back to yet. */}
              {clusterEndpoint && clusterEndpoint !== primary && clusterEndpoint.host && (
                <div className="space-y-2">
                  <div className="px-1 text-xs font-medium text-muted">{intl.formatMessage({ id: "web.routes.tabs.overview.cluster_address", defaultMessage: "Cluster Address", description: "Overview tab: small heading above the cluster-internal address group, shown when it differs from the external address" })}</div>
                  <EndpointRow label={intl.formatMessage({ id: "web.routes.tabs.overview.host", defaultMessage: "Host", description: "Overview tab: label of the host name row in an address group" })}>
                    <span className="truncate font-mono text-foreground" title={clusterEndpoint.host}>{clusterEndpoint.host}</span>
                    <button
                      className="rounded p-1 text-muted hover:bg-border hover:text-foreground"
                      onClick={() => navigator.clipboard?.writeText(clusterEndpoint.host)}
                      title={intl.formatMessage({ id: "web.routes.tabs.overview.copy", defaultMessage: "Copy", description: "Overview tab: icon-only button tooltip that copies the address to the clipboard; keep it short" })}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </EndpointRow>
                  {clusterEndpoint.port !== undefined && (
                    <EndpointRow label={intl.formatMessage({ id: "web.routes.tabs.overview.port", defaultMessage: "Port", description: "Overview tab: label of the port number row in the cluster address group" })}>
                      <span className="truncate font-mono text-foreground">{clusterEndpoint.port}</span>
                    </EndpointRow>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <PlayersCard roster={roster} fallbackOnline={players} />

          <ServerStatusCard name={name} ns={ns} tmpl={tmpl} running={running} gs={gs} />

          <ServerActionsCard name={name} tmpl={tmpl} gs={gs} ns={ns} onOpenConsole={onOpenConsole} />
        </div>
      </div>
    </div>
  );
}

// Accumulate a rolling window of a metric's samples so the tile can draw a
// trend. Appends only when the value actually changes (the parent re-renders
// on every poll), capped to the last `max` points.
function useMetricHistory(value: number | undefined, max = 32): number[] {
  const [hist, setHist] = useState<number[]>([]);
  useEffect(() => {
    if (value === undefined || Number.isNaN(value)) return;
    const appendSample = () => {
      setHist((h) => {
        const next = h.concat(value);
        return next.length > max ? next.slice(-max) : next;
      });
    };
    appendSample();
  }, [value, max]);
  return hist;
}

function ResourceCard({
  label,
  icon,
  value,
  sub,
  progress,
  trend,
  accent,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  sub?: ReactNode;
  progress?: number;
  trend?: number;
  accent?: "primary" | "success" | "warning" | "violet";
}) {
  const accentClass = {
    primary: "bg-accent",
    success: "bg-success-soft-foreground",
    warning: "bg-warning",
    violet: "bg-violet",
  }[accent ?? "primary"];
  const accentText = {
    primary: "text-accent",
    success: "text-success-soft-foreground",
    warning: "text-warning",
    violet: "text-violet",
  }[accent ?? "primary"];
  const history = useMetricHistory(trend);
  return (
    <Card className="flex flex-col gap-2 border border-border bg-card p-4">
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.5px] text-muted">
        <span>{label}</span>
        <span className="text-muted">{icon}</span>
      </div>
      <div className="font-mono text-2xl font-bold text-foreground">{value}</div>
      <Sparkline data={history} className={accentText} />
      {progress !== undefined && (
        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--default)]">
          <div
            className={`h-full ${accentClass}`}
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>
      )}
      {sub && <div className="space-y-0.5 text-xs text-muted">{sub}</div>}
    </Card>
  );
}

function AllocationCard({
  label,
  icon,
  used,
  request,
  limit,
  format,
  accent,
}: {
  label: string;
  icon: ReactNode;
  used?: number;
  request?: number;
  limit?: number;
  format: (value: number) => string;
  accent: string;
}) {
  const intl = useOptionalIntl();
  const scale = Math.max(used ?? 0, request ?? 0, limit ?? 0);
  const width = (value: number) => `${scale ? Math.min(100, (value / scale) * 100) : 0}%`;
  const share = (value?: number) => (used !== undefined && value ? " " + intl.formatMessage({ id: "web.routes.tabs.overview.allocation_used_share", defaultMessage: "· {percent}% used", description: "Overview: share of the allocation in use, shown after a request or limit value; {percent} is a whole percentage" }, { percent: String(Math.round((used / value) * 100)) }) : "");
  return (
    <Card className="flex flex-col gap-3 border border-border bg-card p-4">
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.5px] text-muted">
        <span>{label}</span>
        <span>{icon}</span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-[var(--default)]">
        {request !== undefined && <div className="absolute inset-y-0 left-0 bg-foreground/15" style={{ width: width(request) }} />}
        {used !== undefined && <div className={`absolute inset-y-0 left-0 rounded-full ${accent}`} style={{ width: width(used) }} />}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-muted">{intl.formatMessage({ id: "web.routes.tabs.overview.request", defaultMessage: "Request", description: "Overview: label of the request row in an allocation card; the amount reserved for the server" })}</dt>
        <dd className="text-right font-mono text-foreground">{request === undefined ? intl.formatMessage({ id: "web.routes.tabs.overview.allocation_not_set", defaultMessage: "Not set", description: "Overview: value of the request row when no request is set for the server" }) : format(request) + share(request)}</dd>
        <dt className="text-muted">{intl.formatMessage({ id: "web.routes.tabs.overview.limit", defaultMessage: "Limit", description: "Overview: label of the limit row in an allocation card; the most the server may use" })}</dt>
        <dd className="text-right font-mono text-foreground">{limit === undefined ? intl.formatMessage({ id: "web.routes.tabs.overview.allocation_no_limit", defaultMessage: "None, can burst to node", description: "Overview: value of the limit row when no limit is set, so the server can burst to the node's capacity" }) : format(limit) + share(limit)}</dd>
      </dl>
      <p className="text-[11px] text-muted">{intl.formatMessage({ id: "web.routes.tabs.overview.request_is_reserved_for_the_server_the", defaultMessage: "Request is reserved for the server; the limit is the most it may use.", description: "Overview: note under an allocation card saying the request is reserved for the server and the limit is the most it may use" })}</p>
    </Card>
  );
}

type Condition = NonNullable<NonNullable<GameServer["status"]>["conditions"]>[number];

function conditionRow(condition: Condition, text: string | undefined): [string, ReactNode] {
  const healthy = condition.type === "Progressing" ? condition.status !== "True" : condition.status === "True";
  return [
    condition.type,
    <span key={condition.type} title={text} className={healthy ? "text-success-soft-foreground" : "text-warning"}>
      {condition.reason || condition.status}
    </span>,
  ];
}

function DetailsCard({ label, icon, rows }: { label: string; icon: ReactNode; rows: [string, ReactNode][] }) {
  return (
    <Card className="flex flex-col gap-3 border border-border bg-card p-4">
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.5px] text-muted">
        <span>{label}</span>
        <span>{icon}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted">{term}</dt>
            <dd className="truncate text-right font-mono text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function cpuCores(quantity?: string): number | undefined {
  const amount = parseCpuQuantity(quantity);
  if (!amount) return undefined;
  return amount.unit === "m" ? amount.value / 1000 : amount.value;
}

function memoryBytes(quantity?: string): number | undefined {
  return parseQuantityToBytes(quantity) || undefined;
}

// 8px address rows per design (assets/design-export/screenshots/EZFW0.png): compact
// bordered rows for each connection value, most with a copy affordance.
function EndpointRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-[8px] border border-border bg-[var(--default)] px-3.5 py-2.5">
      <span className="shrink-0 text-[13px] text-muted">{label}</span>
      <div className="flex min-w-0 items-center justify-end gap-2">{children}</div>
    </div>
  );
}

function PlayersCard({
  roster,
  fallbackOnline,
}: {
  roster?: PlayersResp;
  fallbackOnline: number;
}) {
  const intl = useOptionalIntl();
  const online = roster?.online ?? fallbackOnline;
  // A negative online count is the agent's "unknown" sentinel (RCON
  // unavailable or a stale heartbeat) — render "—", matching the Players tab.
  const onlineUnknown = online < 0;
  const rows = playerRows(roster);
  const supported =
    roster === undefined || roster.capabilities !== undefined;

  return (
    <Card className="border border-border bg-card p-0">
      <CardHeader className="px-6 pb-3 pt-5">
        <div className="flex flex-col gap-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-[1px] text-muted">{intl.formatMessage({ id: "web.routes.tabs.overview.players_online", defaultMessage: "Players online ·", description: "Overview tab: heading of the players card, followed by the online player count or a dash when the count is unknown" })} <span>{onlineUnknown ? intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" }) : online}</span>
          </h3>
          {rows.length > 0 && (
            <span className="text-xs text-muted">{intl.formatMessage({ id: "web.routes.tabs.overview.length_listed", defaultMessage: "{length} listed", description: "Overview: count of listed items in a section heading; {length} is how many items are listed" }, { length: String(rows.length) })}</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-6 pb-6">
        {!supported ? (
          <p className="text-[13px] text-muted">{intl.formatMessage({ id: "web.routes.tabs.overview.player_list_not_supported_for_this_game", defaultMessage: "Player list not supported for this game.", description: "Overview tab: text in the players card saying this game does not provide a player list" })}</p>
        ) : onlineUnknown ? (
          <p className="text-[13px] text-muted">{intl.formatMessage({ id: "web.routes.tabs.overview.player_count_unknown", defaultMessage: "Player count unknown.", description: "Overview tab: text in the players card shown when the online player count cannot be read" })}</p>
        ) : online === 0 ? (
          <p className="text-[13px] text-muted">{intl.formatMessage({ id: "web.routes.tabs.overview.no_players_connected", defaultMessage: "No players connected.", description: "Overview tab: text in the players card shown when no player is connected" })}</p>
        ) : rows.length === 0 ? (
          <p className="text-[13px] text-muted">{intl.formatMessage({ id: "web.routes.tabs.overview.online_online_names_not_yet_available", defaultMessage: "{online} online · names not yet available.", description: "Overview: note under the players card; {online} is the number of players online" }, { online: String(online) })}</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {rows.slice(0, 5).map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface font-mono text-[10px] text-muted">
                  {r.label.slice(0, 2).toUpperCase()}
                </div>
                <span className="truncate font-mono text-foreground">{r.label}</span>
              </li>
            ))}
            {rows.length > 5 && (
              <li className="pl-8 text-xs text-muted">{intl.formatMessage({ id: "web.routes.tabs.overview.length_more", defaultMessage: "+ {length} more", description: "Overview: list footer showing hidden items; {length} is how many more items exist" }, { length: String(rows.length - 5) })}</li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

