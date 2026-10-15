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
import { formatBytes, formatCores, formatRelative, formatUptime, parseQuantityToBytes } from "@/lib/utils";
import { parseCpuQuantity } from "@/lib/quantity";
import { mapServerEvent, type NormalizedServerEvent } from "@/lib/events";
import { playerRows } from "@/lib/players";

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

  if (!gs) return <div className="p-6 text-muted">Loading…</div>;

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
            <Alert.Title className="font-semibold text-sm">
              Waiting on storage — the server can&apos;t provision yet
            </Alert.Title>
            <Alert.Description className="text-sm">
              Ready condition: {provisioningFailure.reason} — {provisioningFailure.message}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-4">
            <ResourceCard
              label="CPU"
              icon={<Cpu className="h-4 w-4" />}
              value={
                cpuKnown ? (cpuLimitMilli ? `${cpuPct.toFixed(0)}%` : `${(cpuMilli / 1000).toFixed(2)} cores`) : "—"
              }
              sub={
                cpuKnown && cpuLimitMilli
                  ? `${(cpuMilli / 1000).toFixed(1)} / ${(cpuLimitMilli / 1000).toFixed(1)} cores`
                  : undefined
              }
              progress={cpuKnown && cpuLimitMilli ? cpuPct : undefined}
              trend={cpuKnown ? (cpuLimitMilli ? cpuPct : cpuMilli) : undefined}
              accent="primary"
            />
            <ResourceCard
              label="Memory"
              icon={<MemoryStick className="h-4 w-4" />}
              value={memKnown ? (memLimit ? `${memPct.toFixed(0)}%` : formatBytes(memUsed)) : "—"}
              sub={
                memKnown ? `${formatBytes(memUsed)} / ${memLimit ? formatBytes(memLimit) : "—"}` : undefined
              }
              progress={memKnown && memLimit ? memPct : undefined}
              trend={memKnown && memLimit ? memPct : undefined}
              accent="violet"
            />
            <ResourceCard
              label="Disk"
              icon={<HardDrive className="h-4 w-4" />}
              value={diskKnown ? (diskTotal ? `${diskPct.toFixed(0)}%` : formatBytes(diskUsed)) : "—"}
              sub={
                diskKnown ? `${formatBytes(diskUsed)} / ${diskTotal ? formatBytes(diskTotal) : "—"}` : undefined
              }
              progress={diskKnown && diskTotal ? diskPct : undefined}
              trend={diskKnown && diskTotal ? diskPct : undefined}
              accent="success"
            />
            <ResourceCard
              label="Network"
              icon={<ArrowDownUp className="h-4 w-4" />}
              value={netRateKnown ? `${formatBytes(netRxRate + netTxRate)}/s` : "—"}
              sub={
                netRateKnown || netTotalKnown ? (
                  <>
                    {netRateKnown && <div>{`In ${formatBytes(netRxRate)}/s · Out ${formatBytes(netTxRate)}/s`}</div>}
                    {netTotalKnown && (
                      <div>{`Since pod start: ${formatBytes(netRxTotal)} in · ${formatBytes(netTxTotal)} out`}</div>
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
              label="CPU allocation"
              icon={<Cpu className="h-4 w-4" />}
              used={cpuKnown ? cpuMilli / 1000 : undefined}
              request={cpuRequestCores}
              limit={cpuLimitCores}
              format={(cores) => `${formatCores(cores)} cores`}
              accent="bg-accent"
            />
            <AllocationCard
              label="Memory allocation"
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
              label="Server details"
              icon={<ServerCog className="h-4 w-4" />}
              rows={[
                ["Template", tmpl?.spec.displayName ?? gs.spec.templateRef.name],
                ["Game version", agent?.gameVersion ?? gs.spec.version ?? tmpl?.spec.version ?? "—"],
                ["Uptime", running ? formatUptime(status.startedAt) : "—"],
                ["Capacity", agent?.playersMax ? `${players} / ${agent.playersMax}` : "—"],
                ["Exposure", gs.spec.networking?.expose ?? "ClusterIP"],
                ["Stop grace", `${gs.spec.stopGracePeriodSeconds ?? 30}s`],
              ]}
            />
            <DetailsCard
              label="Health"
              icon={<HeartPulse className="h-4 w-4" />}
              rows={[
                ...(status.conditions ?? []).map(conditionRow),
                ["Last heartbeat", `${formatRelative(agent?.lastHeartbeat)}${agent?.stale ? " · stale" : ""}`],
                ["Last backup", formatRelative(status.lastBackupTime)],
                ["Agent", agent?.version ?? "—"],
              ]}
            />
          </div>

          <Card className="border border-border bg-card p-0">
            <CardHeader className="flex flex-col gap-0 border-b border-border px-6 pb-5 pt-5">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-[1px] text-muted">Recent events</h3>
                <button
                  className="text-xs text-accent hover:underline"
                  onClick={onViewAllEvents}
                >
                  View all
                </button>
              </div>
            </CardHeader>
            <CardContent className="px-0">
              <EventList
                events={events}
                emptyMessage="No events yet. Lifecycle, backup, and agent activity will appear here."
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <ServerSleepCard gs={gs} />

          <Card className="border border-border bg-card p-0">
            <CardHeader className="px-6 pb-3 pt-5">
              <h3 className="text-[11px] font-semibold uppercase tracking-[1px] text-muted">Connection</h3>
            </CardHeader>
            <CardContent className="space-y-3 px-6 pb-5 text-[13px]">
              {/* Tunnel row — only when a tunnel endpoint actually exists;
                  per design (EZFW0) this row doesn't appear at all otherwise. */}
              {primary?.tunnelProvider && (
                <EndpointRow label="Tunnel">
                  {primary.host ? (
                    <>
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="truncate font-mono text-foreground">
                          {primary.host}
                          {primary.port !== undefined ? `:${primary.port}` : ""}
                        </span>
                        {primary.private && (
                          <span className="shrink-0 rounded-full bg-warning/20 px-2 py-0.5 text-[10px] font-medium text-warning">
                            Tailnet only
                          </span>
                        )}
                      </div>
                      <button
                        className="rounded p-1 text-muted hover:bg-border hover:text-foreground"
                        onClick={() => navigator.clipboard?.writeText(primary.host)}
                        title="Copy"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <span className="text-muted italic">
                      {tunnelReady?.message ?? "Waiting for tunnel address…"}
                    </span>
                  )}
                </EndpointRow>
              )}

              {/* External Address row — bare host, no port; a "pool: <name>"
                  annotation underneath when the address was allocated from a
                  pool (EZFW0: "Address 172.18.255.203" / "pool: pool-us-west"). */}
              <EndpointRow label="External Address">
                {primary?.host ? (
                  <>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-mono text-foreground">{primary.host}</span>
                      {primary.pool && (
                        <span className="text-xs text-muted">pool: {primary.pool}</span>
                      )}
                    </div>
                    <button
                      className="rounded p-1 text-muted hover:bg-border hover:text-foreground"
                      onClick={() => navigator.clipboard?.writeText(primary.host)}
                      title="Copy"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <span className="text-muted italic">—</span>
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
                  <div className="px-1 text-xs font-medium text-muted">Cluster Address</div>
                  <EndpointRow label="Host">
                    <span className="truncate font-mono text-foreground">{clusterEndpoint.host}</span>
                    <button
                      className="rounded p-1 text-muted hover:bg-border hover:text-foreground"
                      onClick={() => navigator.clipboard?.writeText(clusterEndpoint.host)}
                      title="Copy"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </EndpointRow>
                  {clusterEndpoint.port !== undefined && (
                    <EndpointRow label="Port">
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
  const scale = Math.max(used ?? 0, request ?? 0, limit ?? 0);
  const width = (value: number) => `${scale ? Math.min(100, (value / scale) * 100) : 0}%`;
  const share = (value?: number) => (used !== undefined && value ? ` · ${Math.round((used / value) * 100)}% used` : "");
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
        <dt className="text-muted">Request</dt>
        <dd className="text-right font-mono text-foreground">{request === undefined ? "Not set" : `${format(request)}${share(request)}`}</dd>
        <dt className="text-muted">Limit</dt>
        <dd className="text-right font-mono text-foreground">{limit === undefined ? "None, can burst to node" : `${format(limit)}${share(limit)}`}</dd>
      </dl>
      <p className="text-[11px] text-muted">Request is reserved for the server; the limit is the most it may use.</p>
    </Card>
  );
}

type Condition = NonNullable<NonNullable<GameServer["status"]>["conditions"]>[number];

function conditionRow(condition: Condition): [string, ReactNode] {
  const healthy = condition.type === "Progressing" ? condition.status !== "True" : condition.status === "True";
  return [
    condition.type,
    <span key={condition.type} title={condition.message} className={healthy ? "text-success-soft-foreground" : "text-warning"}>
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
          <h3 className="text-[11px] font-semibold uppercase tracking-[1px] text-muted">
            Players online ·{" "}
            <span>{onlineUnknown ? "—" : online}</span>
          </h3>
          {rows.length > 0 && (
            <span className="text-xs text-muted">{rows.length} listed</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-6 pb-6">
        {!supported ? (
          <p className="text-[13px] text-muted">
            Player list not supported for this game.
          </p>
        ) : onlineUnknown ? (
          <p className="text-[13px] text-muted">Player count unknown.</p>
        ) : online === 0 ? (
          <p className="text-[13px] text-muted">No players connected.</p>
        ) : rows.length === 0 ? (
          <p className="text-[13px] text-muted">
            {online} online · names not yet available.
          </p>
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
              <li className="pl-8 text-xs text-muted">
                + {rows.length - 5} more
              </li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

