import { useMemo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, Card } from "@heroui/react";
import {
  Activity,
  Archive,
  CheckCircle2,
  Cpu,
  HardDrive,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Server as ServerIcon,
  Square,
  Trash2,
  UserPlus,
  Users as UsersIcon,
  type LucideIcon,
} from "lucide-react";

import { StatCard } from "@/components/ui/StatCard";
import { Meter } from "@/components/ui/Meter";
import { PhaseChip } from "@/components/ui/PhaseChip";
import { GameIcon } from "@/components/ui/GameIcon";
import { LoadingCard } from "@/components/ui/LoadingCard";
import { ErrorCard } from "@/components/ui/ErrorCard";
import { PageHeader } from "@/components/PageHeader";
import {
  cn,
  describeStorageProvisioned,
  formatBytes,
  formatCores,
  formatRelative,
  formatSize,
  type StorageReading,
} from "@/lib/utils";
import { useMe, can } from "@/lib/auth";
import { Audit } from "@/lib/endpoints";
import { useFleetLocation, Fleet, inventoryTotals, playerCoverage, templateKey, useFleetGameCodes, located, resourceTarget, sumNodeUsage, targetKey, targetLabel, targetSearch, useFleetPlacements, useFleetServers } from "@/lib/fleet";
import { FleetCoverage, FleetScopeFilter } from "@/components/FleetScope";
import { countByState, phaseGroups, type PhaseGroups } from "@/lib/servers";
import type {
  AuditEvent,
  Backup,
  ClusterNode,
  GameServer,
  GameTemplate,
} from "@/types";

export function DashboardPage() {
  const { data: placements } = useFleetPlacements();
  const canCreate = (placements?.items.length ?? 0) > 0;
  const [location, setLocation] = useFleetLocation();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const canAudit = can(me, "audit:read");
  const { data: scopes } = useFleetServers();
  const { data: fleet, isLoading: serversLoading, error: serversError } = useFleetServers({ cluster: location || undefined });
  const { gameCodes, byName } = useFleetGameCodes(fleet?.items);
  const { data: inventory, isLoading: clusterLoading, error: clusterError } = useQuery({
    queryKey: ["fleet", "inventory", location], queryFn: ({ signal }) => Fleet.inventory({ cluster: location || undefined }, signal), staleTime: 30_000,
  });
  const { data: backupsFleet, isLoading: backupsLoading, error: backupsError } = useQuery({
    queryKey: ["fleet", "backups", location], queryFn: ({ signal }) => Fleet.backups({ cluster: location || undefined }, signal), staleTime: 30_000,
  });
  const serversData = useMemo(() => ({ items: (fleet?.items ?? []).filter((item) => !location || item.target.cluster === location).map(located) }), [fleet, location]);
  const backupsData = useMemo(() => ({ items: (backupsFleet?.items ?? []).filter((item) => !location || item.target.cluster === location).map(located) }), [backupsFleet, location]);
  const clusterView = inventoryTotals((inventory?.items ?? []).filter((item) => !location || item.cluster === location));
  const canCluster = (inventory?.items.length ?? 0) > 0;
  const { data: audit, isLoading: auditLoading } = useQuery({
    queryKey: ["audit", "dashboard"],
    queryFn: () => Audit.page(8, 0),
    enabled: canAudit,
    staleTime: 30_000,
  });

  const servers = useMemo(() => serversData?.items ?? [], [serversData?.items]);
  const countsUnavailable = !!serversError || (fleet?.partial === true && servers.length === 0);
  const counts = useMemo(() => countByState(servers), [servers]);
  const players = playerCoverage(servers);
  const groups = useMemo(() => phaseGroups(servers), [servers]);
  const recentBackups = useMemo(
    () => sortBackups(backupsData?.items ?? []).slice(0, 6),
    [backupsData?.items],
  );

  const nodes = clusterError ? [] : clusterView.nodes;
  const nodesReady = clusterView.ready;
  const nodesTotal = clusterView.total;
  const cpu = inventory?.partial ? { known: false, pct: 0 } : sumUsage(nodes, "cpu");
  const mem = inventory?.partial ? { known: false, pct: 0 } : sumUsage(nodes, "memory");
  const cpuAllocation = inventory?.partial ? UNKNOWN_ALLOCATION : sumAllocation(nodes, "cpu");
  const memAllocation = inventory?.partial ? UNKNOWN_ALLOCATION : sumAllocation(nodes, "memory");
  const network = sumNetwork(servers);
  const vcpus = nodes.reduce((sum, n) => sum + (n.cpu?.capacity ?? 0), 0);
  const storage = clusterView.usedStorageBytes === undefined ? { valueText: "—", subText: "inventory unavailable", overcommitted: false } : describeStorageProvisioned(clusterView.usedStorageBytes, clusterView.totalStorageBytes);
  const storagePct = clusterView.totalStorageBytes ? ((clusterView.usedStorageBytes ?? 0) / clusterView.totalStorageBytes) * 100 : 0;
  const isLoading = serversLoading || clusterLoading || backupsLoading || (canAudit && auditLoading);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Dashboard"
        subtitle="Your game servers and resources across authorized locations."
        actions={canCreate ?
          <Button
            variant="primary"
            className="rounded-full"
            onPress={() => void navigate({ to: "/servers/new" })}
          >
            <Plus className="h-4 w-4" /> Create server
          </Button> : undefined
        }
      />

      <FleetScopeFilter value={location} onChange={setLocation} clusters={[...(scopes?.scopes ?? []).map((scope) => scope.cluster), ...(scopes?.items ?? []).map((item) => item.target.cluster), ...(scopes?.issues ?? []).map((issue) => issue.cluster), ...(inventory?.items ?? []).map((item) => item.cluster)]} />
      <FleetCoverage partial={fleet?.partial} issues={fleet?.issues} error={serversError} label="Server totals" />
      <FleetCoverage partial={inventory?.partial} issues={inventory?.issues} error={clusterError} label="Inventory" />
      <FleetCoverage partial={backupsFleet?.partial} issues={backupsFleet?.issues} error={backupsError} label="Backups" />

      {isLoading ? (
        <LoadingCard message="Loading dashboard…" />
      ) : (
        <>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
            <StatCard
              label="Running"
              icon={<Activity className="h-4 w-4" />}
              value={countsUnavailable ? "—" : counts.running}
              sub={countsUnavailable ? "server status unavailable" : `of ${groups.total} ${fleet?.partial ? "returned" : "total"}`}
              accent={countsUnavailable ? "warning" : "success"}
            />
            <StatCard
              label="Players online"
              icon={<UsersIcon className="h-4 w-4" />}
              value={countsUnavailable || !players.known ? "—" : counts.players}
              sub={countsUnavailable || !players.known ? "player status unavailable" : players.unknown ? `${players.unknown} server player counts unavailable` : `peak ${counts.playersMax}`}
              accent="primary"
            />
            <StatCard
              label="vCPUs"
              icon={<Cpu className="h-4 w-4" />}
              value={vcpus > 0 ? vcpus : "—"}
              sub={inventory?.partial ? "returned inventory cores" : "authorized inventory cores"}
              accent="warning"
            />
            <StatCard
              label="Storage provisioned"
              icon={<HardDrive className="h-4 w-4" />}
              value={storage.valueText}
              sub={storage.subText ?? "—"}
              accent={storage.overcommitted ? "warning" : "violet"}
            />
            <StatCard
              label="Nodes ready"
              icon={<ServerIcon className="h-4 w-4" />}
              value={!clusterError && nodesTotal > 0 ? `${nodesReady}/${nodesTotal}` : "—"}
              sub={
                clusterError
                  ? "inventory unavailable"
                  : nodesTotal === 0
                  ? "no node data"
                  : inventory?.partial
                    ? "returned nodes only"
                  : nodesReady === nodesTotal
                    ? "all healthy"
                    : "needs attention"
              }
              accent="warning"
            />
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {countsUnavailable
              ? <ErrorCard message={"Couldn't load servers. Status and player totals are unavailable."} />
              : <FleetStatusCard complete={!fleet?.partial} groups={groups} gameCodes={gameCodes} byName={byName} />}
            <ClusterResourcesCard
              cpu={cpu}
              mem={mem}
              storage={storage}
              storagePct={storagePct}
              nodes={nodes}
              nodesReady={nodesReady}
              nodesTotal={nodesTotal}
              canViewCluster={canCluster}
              network={network}
            />
            <AllocationCard cpu={cpuAllocation} mem={memAllocation} />
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
            {canAudit && <div className="space-y-2"><p className="text-xs text-muted">Central Gameplane audit activity</p><RecentActivityCard events={audit ?? []} /></div>}
            {backupsError
              ? <ErrorCard message={"Couldn't load backups. Backup status is unavailable."} />
              : <RecentBackupsCard complete={!backupsFleet?.partial} backups={recentBackups} gameCodes={gameCodes} byName={byName} servers={serversData?.items} />}
          </div>
        </>
      )}
    </div>
  );
}

function FleetStatusCard({
  complete,
  groups,
  gameCodes,
  byName,
}: {
  complete: boolean;
  groups: PhaseGroups;
  gameCodes: Map<string, string>;
  byName: Map<string, GameTemplate>;
}) {
  const stopped = groups.stopped + groups.other;
  const segments = [
    { n: groups.running, cls: "bg-success" },
    { n: stopped, cls: "bg-muted" },
    { n: groups.failed, cls: "bg-danger" },
  ].filter((s) => s.n > 0);
  const attention = groups.attention.slice(0, 4);

  return (
    <Card className="min-w-0 space-y-4 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Fleet status</h3>
        <span className="text-xs text-muted">{groups.total} {complete ? "servers" : "returned servers"}</span>
      </div>

      <div className="flex h-2 overflow-hidden rounded-full bg-surface">
        {groups.total > 0 &&
          segments.map((s, i) => (
            <div key={i} className={s.cls} style={{ width: `${(s.n / groups.total) * 100}%` }} />
          ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
        <LegendDot cls="bg-success" label={`Running ${groups.running}`} />
        <LegendDot cls="bg-muted" label={`Stopped ${stopped}`} />
        <LegendDot cls="bg-danger" label={`Failed ${groups.failed}`} />
      </div>

      <div className="space-y-3 border-t border-border pt-4">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted">
          Needs attention
        </div>
        {attention.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <CheckCircle2 className="h-4 w-4 text-success" /> {complete ? "Everything looks healthy." : "No issues among returned servers; some locations are unavailable."}
          </div>
        ) : (
          attention.map((gs) => (
            <AttentionRow key={targetKey(resourceTarget(gs))} gs={gs} gameCodes={gameCodes} byName={byName} />
          ))
        )}
      </div>
    </Card>
  );
}

function AttentionRow({
  gs,
  gameCodes,
  byName,
}: {
  gs: GameServer;
  gameCodes: Map<string, string>;
  byName: Map<string, GameTemplate>;
}) {
  const phase = gs.status?.phase;
  // phaseGroups.attention only ever holds Failed-phase or stale-agent
  // (excluding expected-down) servers, so the reason is one of exactly
  // these two.
  const reason = phase === "Failed" ? "Failed — check logs" : "Agent heartbeat stale";
  return (
    <Link
      to="/servers/$name"
      params={{ name: gs.metadata.name }}
      search={targetSearch(resourceTarget(gs))}
      className="group flex items-center gap-3"
    >
      <GameIcon
        game={gs.spec.templateRef.name}
        icon={byName.get(templateKey(resourceTarget(gs).cluster, gs.spec.templateRef.name))?.spec.icon}
        code={gameCodes.get(templateKey(resourceTarget(gs).cluster, gs.spec.templateRef.name))}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-sm text-foreground group-hover:text-primary">
          {gs.metadata.name}
        </div>
        <div className="truncate text-[11px] text-muted">{targetLabel(resourceTarget(gs))} · {reason}</div>
      </div>
      <PhaseChip phase={phase} asleep={gs.status?.idle?.asleep === true} />
    </Link>
  );
}

interface Allocation {
  known: boolean;
  requestPct: number;
  limitPct: number;
  requestSub?: string;
  limitSub?: string;
}

const UNKNOWN_ALLOCATION: Allocation = { known: false, requestPct: 0, limitPct: 0 };

interface NetworkUsage {
  known: boolean;
  rx: number;
  tx: number;
  servers: number;
}

interface Usage {
  pct: number;
  sub?: string;
  // known is false when no node reported a `used` reading (no
  // metrics-server) — the meter must show "—", not a false 0%.
  known: boolean;
}

function ClusterResourcesCard({
  cpu,
  mem,
  storage,
  storagePct,
  nodes,
  nodesReady,
  nodesTotal,
  canViewCluster,
  network,
}: {
  cpu: Usage;
  mem: Usage;
  storage: StorageReading;
  storagePct: number;
  nodes: ClusterNode[];
  nodesReady: number;
  nodesTotal: number;
  canViewCluster: boolean;
  network: NetworkUsage;
}) {
  return (
    <Card className="min-w-0 space-y-4 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Cluster resources</h3>
          <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
            Live
          </span>
        </div>
        {canViewCluster ? (
          <Link to="/clusters" className="text-xs text-primary hover:underline">
            View clusters
          </Link>
        ) : (
          <span className="text-xs text-muted">
            {nodesTotal > 0 ? `${nodesReady}/${nodesTotal} nodes ready` : "—"}
          </span>
        )}
      </div>

      <div className="space-y-3">
        <Meter label="CPU" pct={cpu.pct} sub={cpu.sub} unknown={!cpu.known} accent="primary" />
        <Meter label="Memory" pct={mem.pct} sub={mem.sub} unknown={!mem.known} accent="violet" />
        <Meter
          label="Storage"
          pct={storagePct}
          sub={storage.subText}
          unknown={storage.valueText === "—"}
          accent={storage.overcommitted ? "warning" : "success"}
        />
        <div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted">Network</span>
            <span className={cn("font-mono", network.known ? "text-foreground" : "text-muted")}>
              {network.known ? `${formatBytes(network.rx + network.tx)}/s` : "—"}
            </span>
          </div>
          <div className="pt-1 text-[10px] text-muted">
            {network.known
              ? `In ${formatBytes(network.rx)}/s · Out ${formatBytes(network.tx)}/s · ${network.servers} game ${network.servers === 1 ? "server" : "servers"}`
              : "no game server traffic reported"}
          </div>
        </div>
      </div>

      {nodes.length > 0 && (
        <div className="space-y-2 border-t border-border pt-4">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted">Nodes</div>
          {nodes.slice(0, 4).map((n) => (
            <NodeRow key={n.name} node={n} />
          ))}
        </div>
      )}
    </Card>
  );
}

function AllocationCard({ cpu, mem }: { cpu: Allocation; mem: Allocation }) {
  return (
    <Card className="min-w-0 space-y-4 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Allocation</h3>
        <span className="text-xs text-muted">pod requests &amp; limits</span>
      </div>
      <div className="space-y-3">
        <Meter label="CPU requested" pct={cpu.requestPct} sub={cpu.requestSub} unknown={!cpu.known} accent="primary" />
        <Meter label="CPU limits" pct={cpu.limitPct} sub={cpu.limitSub} unknown={!cpu.known} accent={cpu.limitPct > 100 ? "warning" : "primary"} />
        <Meter label="Memory requested" pct={mem.requestPct} sub={mem.requestSub} unknown={!mem.known} accent="violet" />
        <Meter label="Memory limits" pct={mem.limitPct} sub={mem.limitSub} unknown={!mem.known} accent={mem.limitPct > 100 ? "warning" : "violet"} />
      </div>
      <p className="border-t border-border pt-4 text-[11px] text-muted">
        Requests are reserved by the scheduler; limits are the most pods may burst to and can exceed capacity.
      </p>
    </Card>
  );
}

function NodeRow({ node }: { node: ClusterNode }) {
  const ready = node.status === "Ready";
  const cpuKnown = node.cpu?.used !== undefined;
  const cpuPct = pctOf(node.cpu?.used, node.cpu?.capacity);
  const meta = [
    node.pods?.used !== undefined ? `${node.pods.used} pods` : null,
    cpuKnown && node.cpu?.capacity ? `cpu ${Math.round(cpuPct)}%` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", ready ? "bg-success" : "bg-danger")} />
      <span className="min-w-0 flex-1 break-all font-mono text-foreground">{node.name}</span>
      <span className="shrink-0 text-muted">{meta || "—"}</span>
    </div>
  );
}

function RecentActivityCard({ events }: { events: AuditEvent[] }) {
  return (
    <Card className="min-w-0 space-y-4 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Recent activity</h3>
        <Link to="/admin/audit" className="text-xs text-primary hover:underline">
          View all
        </Link>
      </div>
      {events.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted">No recent activity.</div>
      ) : (
        <div className="space-y-3">
          {events.map((e) => (
            <ActivityRow key={e.id} event={e} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ActivityRow({ event }: { event: AuditEvent }) {
  const { icon: Icon, accent } = actionIcon(event);
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface">
        <Icon className={cn("h-3.5 w-3.5", accent)} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">{describeAudit(event)}</div>
        <div className="truncate font-mono text-[11px] text-muted">
          {event.method} {event.path}
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted">{formatRelative(event.ts)}</span>
    </div>
  );
}

function RecentBackupsCard({
  complete,
  backups,
  gameCodes,
  byName,
  servers,
}: {
  complete: boolean;
  backups: Backup[];
  gameCodes: Map<string, string>;
  byName: Map<string, GameTemplate>;
  servers?: GameServer[];
}) {
  return (
    <Card className="min-w-0 space-y-4 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Recent backups</h3>
        <Link to="/backups" className="text-xs text-primary hover:underline">
          View all
        </Link>
      </div>
      {backups.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted">{complete ? "No backups yet." : "No backup data available."}</div>
      ) : (
        <div className="space-y-3">
          {backups.map((b) => (
            <BackupRow key={targetKey(resourceTarget(b))} backup={b} gameCodes={gameCodes} byName={byName} servers={servers} />
          ))}
        </div>
      )}
    </Card>
  );
}

function BackupRow({
  backup,
  gameCodes,
  byName,
  servers,
}: {
  backup: Backup;
  gameCodes: Map<string, string>;
  byName: Map<string, GameTemplate>;
  servers?: GameServer[];
}) {
  // Resolve backup server ref to template ref
  const target = resourceTarget(backup);
  const server = servers?.find((s) => s.metadata.name === backup.spec.serverRef.name && resourceTarget(s).cluster === target.cluster && resourceTarget(s).namespace === target.namespace);
  const templateRef = server?.spec.templateRef.name ?? "";
  const when = backup.status?.completionTime ?? backup.status?.startTime;
  return (
    <div className="flex items-center gap-3">
      <GameIcon
        game={templateRef || backup.spec.serverRef.name}
        icon={byName.get(templateKey(target.cluster, templateRef))?.spec.icon}
        code={gameCodes.get(templateKey(target.cluster, templateRef))}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-sm text-foreground">{backup.spec.serverRef.name}</div>
        <div className="truncate text-[11px] text-muted">{targetLabel(target)} · {formatRelative(when)}</div>
      </div>
      {backup.status?.size && (
        <span className="shrink-0 font-mono text-xs text-foreground">{formatSize(backup.status.size)}</span>
      )}
      <PhaseChip phase={backup.status?.phase} />
    </div>
  );
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-muted">
      <span className={cn("h-2 w-2 rounded-full", cls)} />
      {label}
    </span>
  );
}

// sumUsage aggregates a resource across nodes into a percentage and a
// human-readable "used / capacity" subtitle (bytes for memory, cores for
// CPU). `known` is false when not a single node reported a `used` reading
// (no metrics-server anywhere in the cluster) — callers must render that as
// "—", not a 0% bar that implies a measured idle cluster.
function sumUsage(nodes: ClusterNode[], key: "cpu" | "memory"): Usage {
  const reading = sumNodeUsage(nodes, key);
  if (!reading.known) return { pct: 0, known: false };
  const sub = key === "memory"
    ? `${formatBytes(reading.used)} / ${formatBytes(reading.capacity)}`
    : `${formatCores(reading.used)} / ${formatCores(reading.capacity)} cores`;
  return { pct: reading.pct, sub, known: true };
}

function sumAllocation(nodes: ClusterNode[], key: "cpu" | "memory"): Allocation {
  const known = nodes.length > 0 && nodes.every((node) => typeof node[key]?.requests === "number" && (node[key]?.capacity ?? 0) > 0);
  if (!known) return UNKNOWN_ALLOCATION;
  const capacity = nodes.reduce((sum, node) => sum + (node[key]?.capacity ?? 0), 0);
  const requests = nodes.reduce((sum, node) => sum + (node[key]?.requests ?? 0), 0);
  const limits = nodes.reduce((sum, node) => sum + (node[key]?.limits ?? 0), 0);
  const format = (value: number) => (key === "memory" ? formatBytes(value) : `${formatCores(value)} cores`);
  return {
    known: true,
    requestPct: (requests / capacity) * 100,
    limitPct: (limits / capacity) * 100,
    requestSub: `${format(requests)} of ${format(capacity)}`,
    limitSub: `${format(limits)} of ${format(capacity)}`,
  };
}

function sumNetwork(servers: GameServer[]): NetworkUsage {
  const reporting = servers.filter((gs) =>
    typeof gs.status?.agent?.networkRxBytesPerSec === "number" && typeof gs.status?.agent?.networkTxBytesPerSec === "number");
  return {
    known: reporting.length > 0,
    servers: reporting.length,
    rx: reporting.reduce((sum, gs) => sum + (gs.status?.agent?.networkRxBytesPerSec ?? 0), 0),
    tx: reporting.reduce((sum, gs) => sum + (gs.status?.agent?.networkTxBytesPerSec ?? 0), 0),
  };
}

function pctOf(used?: number, cap?: number): number {
  if (used === undefined || !cap) return 0;
  return (used / cap) * 100;
}

function sortBackups(items: Backup[]): Backup[] {
  return [...items].sort((a, b) =>
    (b.status?.startTime ?? "").localeCompare(a.status?.startTime ?? ""),
  );
}

// describeAudit turns an audit row into a one-line human summary. Lifecycle
// sub-resource paths (":start" etc.) and sign-ins get specific verbs; otherwise the verb
// derives from the HTTP method.
function describeAudit(e: AuditEvent): string {
  const target = e.target ? ` ${e.target}` : "";
  if (e.path.endsWith("/auth/login")) {
    return e.status >= 200 && e.status < 300 ? `${e.actor} signed in` : `${e.actor} failed to sign in`;
  }
  if (e.path.includes(":start")) return `${e.actor} started${target}`;
  if (e.path.includes(":stop")) return `${e.actor} stopped${target}`;
  if (e.path.includes(":restart")) return `${e.actor} restarted${target}`;
  if (e.path.includes("/backups")) return `${e.actor} backed up${target}`;
  if (e.path.includes("/users")) return `${e.actor} updated a user${target}`;
  const verb =
    e.method === "DELETE"
      ? "deleted"
      : e.method === "POST"
        ? "created"
        : e.method === "PUT" || e.method === "PATCH"
          ? "updated"
          : e.method.toLowerCase();
  return `${e.actor} ${verb}${target}`.trim();
}

function actionIcon(e: AuditEvent): { icon: LucideIcon; accent: string } {
  if (e.path.includes(":start")) return { icon: Play, accent: "text-success" };
  if (e.path.includes(":stop")) return { icon: Square, accent: "text-muted" };
  if (e.path.includes(":restart")) return { icon: RotateCw, accent: "text-warning" };
  if (e.path.includes("/backups")) return { icon: Archive, accent: "text-violet" };
  if (e.path.includes("/users")) return { icon: UserPlus, accent: "text-primary" };
  if (e.method === "DELETE") return { icon: Trash2, accent: "text-danger" };
  if (e.method === "POST") return { icon: Plus, accent: "text-success" };
  return { icon: Pencil, accent: "text-muted" };
}
