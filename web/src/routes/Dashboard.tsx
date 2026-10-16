import { useMemo, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, Card } from "@heroui/react";
import {
  Activity,
  Archive,
  ArrowRight,
  CheckCircle2,
  HardDrive,
  Info,
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

const ALLOCATION_HINT = "Requests are reserved by the scheduler; limits are the most pods may burst to and can exceed capacity.";

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
  const busiest = useMemo(() => mostPlayers(servers), [servers]);
  const recentBackups = useMemo(
    () => sortBackups(backupsData?.items ?? []).slice(0, 6),
    [backupsData?.items],
  );
  const scopeLabel = location ? `in ${location}` : "across all locations";

  const nodes = clusterError ? [] : clusterView.nodes;
  const nodesReady = clusterView.ready;
  const nodesTotal = clusterView.total;
  const nodesKnown = !clusterError && nodesTotal > 0;
  const cpu = inventory?.partial ? { known: false, pct: 0 } : sumUsage(nodes, "cpu");
  const mem = inventory?.partial ? { known: false, pct: 0 } : sumUsage(nodes, "memory");
  const cpuAllocation = inventory?.partial ? UNKNOWN_ALLOCATION : sumAllocation(nodes, "cpu");
  const memAllocation = inventory?.partial ? UNKNOWN_ALLOCATION : sumAllocation(nodes, "memory");
  const network = sumNetwork(servers);
  const storage = clusterView.usedStorageBytes === undefined ? { valueText: "—", subText: "inventory unavailable", overcommitted: false } : describeStorageProvisioned(clusterView.usedStorageBytes, clusterView.totalStorageBytes);
  const storagePct = clusterView.totalStorageBytes ? ((clusterView.usedStorageBytes ?? 0) / clusterView.totalStorageBytes) * 100 : 0;
  const isLoading = serversLoading || clusterLoading || backupsLoading || (canAudit && auditLoading);

  return (
    <div className="space-y-4 p-4 sm:space-y-6 sm:p-6">
      <PageHeader
        title="Dashboard"
        subtitle="Your game servers and resources across authorized locations."
        actions={
          <>
            <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
              <FleetScopeFilter value={location} onChange={setLocation} clusters={[...(scopes?.scopes ?? []).map((scope) => scope.cluster), ...(scopes?.items ?? []).map((item) => item.target.cluster), ...(scopes?.issues ?? []).map((issue) => issue.cluster), ...(inventory?.items ?? []).map((item) => item.cluster)]} />
            </div>
            {canCreate && (
              <Button
                variant="primary"
                className="rounded-full"
                onPress={() => void navigate({ to: "/servers/new" })}
              >
                <Plus className="h-4 w-4" /> Create server
              </Button>
            )}
          </>
        }
      />

      <FleetCoverage partial={fleet?.partial} issues={fleet?.issues} error={serversError} label="Server totals" />
      <FleetCoverage partial={inventory?.partial} issues={inventory?.issues} error={clusterError} label="Inventory" />
      <FleetCoverage partial={backupsFleet?.partial} issues={backupsFleet?.issues} error={backupsError} label="Backups" />

      {isLoading ? (
        <LoadingCard message="Loading dashboard…" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4 xl:gap-4">
            <KpiCard
              label="Servers running"
              icon={Activity}
              accent="text-success"
              value={countsUnavailable ? "—" : counts.running}
              suffix={countsUnavailable ? undefined : `/ ${groups.total}`}
              sub={
                countsUnavailable
                  ? "server status unavailable"
                  : fleet?.partial
                    ? "returned servers only"
                    : groups.total === 0
                      ? "no servers"
                    : counts.running === groups.total
                      ? "all servers running"
                      : `${groups.total - counts.running} not running`
              }
            />
            <KpiCard
              label="Players online"
              icon={UsersIcon}
              accent="text-accent"
              value={countsUnavailable || !players.known ? "—" : counts.players}
              sub={countsUnavailable || !players.known ? "player status unavailable" : players.unknown ? `${players.unknown} server player counts unavailable` : `peak ${counts.playersMax}`}
            />
            <KpiCard
              label="Nodes ready"
              icon={ServerIcon}
              accent="text-warning"
              value={nodesKnown ? nodesReady : "—"}
              suffix={nodesKnown ? `/ ${nodesTotal}` : undefined}
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
            />
            <KpiCard
              label="Storage provisioned"
              icon={HardDrive}
              accent={storage.overcommitted ? "text-warning" : "text-chart-stat"}
              value={storage.valueText}
              sub={storage.subText ?? "—"}
            />
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            {countsUnavailable
              ? <ErrorCard message={"Couldn't load servers. Status and player totals are unavailable."} />
              : <FleetStatusCard complete={!fleet?.partial} groups={groups} busiest={busiest} scope={scopeLabel} gameCodes={gameCodes} byName={byName} />}
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
              cpuAllocation={cpuAllocation}
              memAllocation={memAllocation}
            />
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
            {canAudit && <RecentActivityCard events={audit ?? []} />}
            <div className={cn("grid min-w-0", !canAudit && "lg:col-span-2")}>
              {backupsError
                ? <ErrorCard message={"Couldn't load backups. Backup status is unavailable."} />
                : <RecentBackupsCard complete={!backupsFleet?.partial} backups={recentBackups} gameCodes={gameCodes} byName={byName} servers={serversData?.items} />}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function KpiCard({
  label,
  icon: Icon,
  accent,
  value,
  suffix,
  sub,
}: {
  label: string;
  icon: LucideIcon;
  accent: string;
  value: ReactNode;
  suffix?: string;
  sub: ReactNode;
}) {
  return (
    <Card className="min-w-0 gap-3 border border-border p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
          <Icon className={cn("h-4 w-4", accent)} />
        </span>
        <span className="min-w-0 text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      </div>
      <div className="flex items-baseline gap-1 font-mono">
        <span className="text-2xl font-bold text-foreground sm:text-[28px]">{value}</span>
        {suffix && <span className="text-base text-muted">{suffix}</span>}
      </div>
      <div className="text-xs text-muted">{sub}</div>
    </Card>
  );
}

function CardHeader({
  title,
  sub,
  badge,
  action,
}: {
  title: string;
  sub?: ReactNode;
  badge?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {badge}
        </div>
        {sub && <p className="text-xs text-muted">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

function CardLink({ to, children }: { to: "/servers" | "/clusters" | "/admin/audit" | "/backups"; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline">
      {children}
      <ArrowRight className="h-3.5 w-3.5" />
    </Link>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{children}</div>;
}

function FleetStatusCard({
  complete,
  groups,
  busiest,
  scope,
  gameCodes,
  byName,
}: {
  complete: boolean;
  groups: PhaseGroups;
  busiest: GameServer[];
  scope: string;
  gameCodes: Map<string, string>;
  byName: Map<string, GameTemplate>;
}) {
  const stopped = groups.stopped + groups.other;
  const segments = [
    { n: groups.running, cls: "bg-success" },
    { n: stopped, cls: "bg-muted" },
    { n: groups.failed, cls: "bg-danger" },
  ].filter((s) => s.n > 0);
  const tiles = [
    { label: "Running", n: groups.running, cls: "bg-success" },
    { label: "Stopped", n: stopped, cls: "bg-muted" },
    { label: "Failed", n: groups.failed, cls: "bg-danger" },
  ];
  const attention = groups.attention.slice(0, 4);

  return (
    <Card className="min-w-0 gap-5 border border-border p-5">
      <CardHeader
        title="Fleet status"
        sub={`${groups.total} ${complete ? "" : "returned "}${groups.total === 1 ? "server" : "servers"} ${scope}`}
        action={<CardLink to="/servers">View servers</CardLink>}
      />

      <div className="flex h-2 overflow-hidden rounded-full bg-border">
        {groups.total > 0 &&
          segments.map((s, i) => (
            <div key={i} className={s.cls} style={{ width: `${(s.n / groups.total) * 100}%` }} />
          ))}
      </div>

      <dl className="grid grid-cols-3 gap-3">
        {tiles.map((tile) => (
          <div key={tile.label} className="min-w-0 space-y-1 rounded-lg border border-border bg-card p-3">
            <dt className="flex items-center gap-2 text-xs text-muted">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", tile.cls)} />
              {tile.label}
            </dt>
            <dd className="font-mono text-xl font-bold text-foreground">{tile.n}</dd>
          </div>
        ))}
      </dl>

      {busiest.length > 0 && (
        <div className="space-y-3">
          <SectionLabel>Most players</SectionLabel>
          {busiest.map((gs) => (
            <PlayerRow key={targetKey(resourceTarget(gs))} gs={gs} gameCodes={gameCodes} byName={byName} />
          ))}
        </div>
      )}

      <div className="space-y-3 border-t border-border pt-5">
        <SectionLabel>Needs attention</SectionLabel>
        {attention.length === 0 ? (
          <div className="flex items-center gap-3 rounded-lg bg-success-soft p-3">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-success-soft-foreground">Everything looks healthy</div>
              <div className="text-xs text-muted">
                {complete ? "No failed servers or stale agents." : "No issues among returned servers; some locations are unavailable."}
              </div>
            </div>
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

function PlayerRow({
  gs,
  gameCodes,
  byName,
}: {
  gs: GameServer;
  gameCodes: Map<string, string>;
  byName: Map<string, GameTemplate>;
}) {
  const target = resourceTarget(gs);
  const template = templateKey(target.cluster, gs.spec.templateRef.name);
  const max = gs.status?.agent?.playersMax;
  return (
    <Link
      to="/servers/$name"
      params={{ name: gs.metadata.name }}
      search={targetSearch(target)}
      className="group flex items-center gap-3"
    >
      <GameIcon game={gs.spec.templateRef.name} icon={byName.get(template)?.spec.icon} code={gameCodes.get(template)} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-sm text-foreground group-hover:text-primary">{gs.metadata.name}</div>
        <div className="truncate text-[11px] text-muted">{targetLabel(target)}</div>
      </div>
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs text-foreground">
        <UsersIcon className="h-3.5 w-3.5 text-muted" />
        {gs.status?.agent?.playersOnline}
        {max ? <span className="text-muted">/ {max}</span> : null}
      </span>
    </Link>
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
  cpuAllocation,
  memAllocation,
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
  cpuAllocation: Allocation;
  memAllocation: Allocation;
}) {
  return (
    <Card className="min-w-0 gap-5 border border-border p-5">
      <CardHeader
        title="Cluster resources"
        badge={
          <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success-soft-foreground">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
            Live
          </span>
        }
        sub={nodesTotal > 0 ? `Usage and scheduler allocation across ${nodesTotal} ${nodesTotal === 1 ? "node" : "nodes"}` : "Usage and scheduler allocation"}
        action={
          canViewCluster ? (
            <CardLink to="/clusters">View clusters</CardLink>
          ) : (
            <span className="shrink-0 text-xs text-muted">
              {nodesTotal > 0 ? `${nodesReady}/${nodesTotal} nodes ready` : "—"}
            </span>
          )
        }
      />

      <div className="grid gap-5 md:grid-cols-2 md:gap-6">
        <div className="min-w-0 space-y-4">
          <SectionLabel>Usage</SectionLabel>
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
        <div className="min-w-0 space-y-4 border-t border-border pt-5 md:border-l md:border-t-0 md:pl-6 md:pt-0">
          <div className="flex items-center gap-1 text-muted">
            <SectionLabel>Allocation</SectionLabel>
            <span role="img" aria-label={ALLOCATION_HINT} title={ALLOCATION_HINT}>
              <Info className="h-3 w-3" />
            </span>
          </div>
          <Meter label="CPU requested" pct={cpuAllocation.requestPct} sub={cpuAllocation.requestSub} unknown={!cpuAllocation.known} accent="primary" />
          <Meter label="CPU limits" pct={cpuAllocation.limitPct} sub={cpuAllocation.limitSub} unknown={!cpuAllocation.known} accent={cpuAllocation.limitPct > 100 ? "warning" : "primary"} />
          <Meter label="Memory requested" pct={memAllocation.requestPct} sub={memAllocation.requestSub} unknown={!memAllocation.known} accent="violet" />
          <Meter label="Memory limits" pct={memAllocation.limitPct} sub={memAllocation.limitSub} unknown={!memAllocation.known} accent={memAllocation.limitPct > 100 ? "warning" : "violet"} />
        </div>
      </div>

      {nodes.length > 0 && (
        <div className="mt-auto space-y-2 border-t border-border pt-4">
          <SectionLabel>Nodes</SectionLabel>
          {nodes.slice(0, 4).map((n) => (
            <NodeRow key={n.name} node={n} />
          ))}
        </div>
      )}
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
    <Card className="min-w-0 gap-5 border border-border p-5">
      <CardHeader
        title="Recent activity"
        sub="Central audit log · not filtered by location"
        action={<CardLink to="/admin/audit">View all</CardLink>}
      />
      {events.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted">No recent activity.</div>
      ) : (
        <div className="space-y-4">
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
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
        <Icon className={cn("h-4 w-4", accent)} />
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
    <Card className="min-w-0 gap-5 border border-border p-5">
      <CardHeader
        title="Recent backups"
        sub="Latest snapshots in the selected locations"
        action={<CardLink to="/backups">View all</CardLink>}
      />
      {backups.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted">{complete ? "No backups yet." : "No backup data available."}</div>
      ) : (
        <div className="space-y-4">
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

function mostPlayers(servers: GameServer[]): GameServer[] {
  const online = (gs: GameServer) => gs.status?.agent?.playersOnline ?? 0;
  return servers
    .filter((gs) => gs.status?.phase === "Running" && !gs.status?.agent?.stale && online(gs) > 0)
    .sort((a, b) => online(b) - online(a))
    .slice(0, 3);
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
