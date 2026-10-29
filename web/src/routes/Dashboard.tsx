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
  describeDiskUsage,
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
import { useOptionalIntl } from "@/lib/i18n/format";
import { defineMessages } from "react-intl";

export function DashboardPage() {
  const intl = useOptionalIntl();
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
  const scopeLabel = location
    ? intl.formatMessage({ id: "web.routes.dashboard.scope_in_location", defaultMessage: "in {location}", description: "Dashboard: phrase ending the fleet status line that names the selected location; {location} is the location name" }, { location })
    : intl.formatMessage({ id: "web.routes.dashboard.scope_all_locations", defaultMessage: "across all locations", description: "Dashboard: phrase ending the fleet status line when no location is selected" });

  const nodes = clusterError ? [] : clusterView.nodes;
  const nodesReady = clusterView.ready;
  const nodesTotal = clusterView.total;
  const nodesKnown = !clusterError && nodesTotal > 0;
  const cpu = inventory?.partial ? { known: false, pct: 0 } : sumUsage(intl, nodes, "cpu");
  const mem = inventory?.partial ? { known: false, pct: 0 } : sumUsage(intl, nodes, "memory");
  const cpuAllocation = inventory?.partial ? UNKNOWN_ALLOCATION : sumAllocation(intl, nodes, "cpu");
  const memAllocation = inventory?.partial ? UNKNOWN_ALLOCATION : sumAllocation(intl, nodes, "memory");
  const network = sumNetwork(servers);
  const emptyValue = intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" });
  const inventoryUnavailable = intl.formatMessage({ id: "web.routes.dashboard.inventory_unavailable", defaultMessage: "inventory unavailable", description: "Dashboard: sub-label on the storage and nodes cards when inventory cannot be read" });
  const disk = clusterView.disk;
  const diskUnknown = nodesKnown
    ? intl.formatMessage({ id: "web.routes.dashboard.disk_needs_prometheus", defaultMessage: "needs Prometheus", description: "Dashboard: sub-label on the disk card and storage meter when disk usage cannot be measured because Prometheus is not connected" })
    : inventoryUnavailable;
  const storage = disk ? describeDiskUsage(disk.used, disk.total, intl) : { valueText: emptyValue, subText: diskUnknown };
  const storageKnown = disk !== undefined;
  const storagePct = disk ? (disk.used / disk.total) * 100 : 0;
  const isLoading = serversLoading || clusterLoading || backupsLoading || (canAudit && auditLoading);

  return (
    <div className="space-y-4 p-4 sm:space-y-6 sm:p-6">
      <PageHeader
        title={intl.formatMessage({ id: "web.routes.dashboard.dashboard", defaultMessage: "Dashboard", description: "Dashboard: page title at the top of the dashboard; keep it short" })}
        subtitle={intl.formatMessage({ id: "web.routes.dashboard.your_game_servers_and_resources_across", defaultMessage: "Your game servers and resources across authorized locations.", description: "Dashboard: subtitle under the page title saying the page shows game servers and resources in the locations the user may access" })}
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
                <Plus className="h-4 w-4" /> {intl.formatMessage({ id: "web.routes.dashboard.create_server", defaultMessage: "Create server", description: "Dashboard: button at the top right that opens the form to create a new game server; keep it short" })}
              </Button>
            )}
          </>
        }
      />

      <FleetCoverage partial={fleet?.partial} issues={fleet?.issues} error={serversError} label={intl.formatMessage({ id: "web.routes.dashboard.server_totals", defaultMessage: "Server totals", description: "Dashboard: label naming the server data in the coverage status line; that line warns when server data is partial or failed" })} />
      <FleetCoverage partial={inventory?.partial} issues={inventory?.issues} error={clusterError} label={intl.formatMessage({ id: "web.routes.dashboard.inventory", defaultMessage: "Inventory", description: "Dashboard: label naming the cluster inventory data in the coverage status line; that line warns when inventory is partial or failed" })} />
      <FleetCoverage partial={backupsFleet?.partial} issues={backupsFleet?.issues} error={backupsError} label={intl.formatMessage({ id: "web.routes.dashboard.backups", defaultMessage: "Backups", description: "Dashboard: label naming the backup data in the coverage status line; that line warns when backup data is partial or failed" })} />

      {isLoading ? (
        <LoadingCard message={intl.formatMessage({ id: "web.routes.dashboard.loading_dashboard", defaultMessage: "Loading dashboard…", description: "Dashboard: loading text shown in place of the dashboard cards while the data loads" })} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4 xl:gap-4">
            <KpiCard
              label={intl.formatMessage({ id: "web.routes.dashboard.servers_running", defaultMessage: "Servers running", description: "Dashboard: label of the KPI card counting running game servers against all servers" })}
              icon={Activity}
              accent="text-success"
              value={countsUnavailable ? emptyValue : counts.running}
              suffix={countsUnavailable ? undefined : `/ ${groups.total}`}
              sub={
                countsUnavailable
                  ? intl.formatMessage({ id: "web.routes.dashboard.server_status_unavailable", defaultMessage: "server status unavailable", description: "Dashboard: sub-label on the Running card when server data cannot be read" })
                  : fleet?.partial
                    ? intl.formatMessage({ id: "web.routes.dashboard.returned_servers_only", defaultMessage: "returned servers only", description: "Dashboard: sub-label on the Servers running card when only returned servers are counted" })
                    : groups.total === 0
                      ? intl.formatMessage({ id: "web.routes.dashboard.no_servers", defaultMessage: "no servers", description: "Dashboard: sub-label on the Servers running card when there are no servers" })
                    : counts.running === groups.total
                      ? intl.formatMessage({ id: "web.routes.dashboard.all_servers_running", defaultMessage: "all servers running", description: "Dashboard: sub-label on the Servers running card when every server is running" })
                      : intl.formatMessage({ id: "web.routes.dashboard.servers_not_running", defaultMessage: "{count} not running", description: "Dashboard: sub-label on the Servers running card with the number of servers that are not running; {count} is that number" }, { count: groups.total - counts.running })
              }
            />
            <KpiCard
              label={intl.formatMessage({ id: "web.routes.dashboard.players_online", defaultMessage: "Players online", description: "Dashboard: label of the summary card for players online; the line under the number shows the peak or a note when counts are unavailable" })}
              icon={UsersIcon}
              accent="text-accent"
              value={countsUnavailable || !players.known ? emptyValue : counts.players}
              sub={countsUnavailable || !players.known
                ? intl.formatMessage({ id: "web.routes.dashboard.player_status_unavailable", defaultMessage: "player status unavailable", description: "Dashboard: sub-label on the Players online card when player counts cannot be read" })
                : players.unknown
                  ? intl.formatMessage({ id: "web.routes.dashboard.player_counts_unavailable", defaultMessage: "{count} server player counts unavailable", description: "Dashboard: sub-label on the Players online card when some servers report no player count; {count} is how many" }, { count: players.unknown })
                  : intl.formatMessage({ id: "web.routes.dashboard.peak_players", defaultMessage: "peak {count}", description: "Dashboard: sub-label on the Players online card with the peak player count; {count} is the peak" }, { count: counts.playersMax })}
            />
            <KpiCard
              label={intl.formatMessage({ id: "web.routes.dashboard.nodes_ready", defaultMessage: "Nodes ready", description: "Dashboard: label of the summary card counting ready nodes; the value shows ready nodes out of all nodes" })}
              icon={ServerIcon}
              accent="text-warning"
              value={nodesKnown ? nodesReady : emptyValue}
              suffix={nodesKnown ? `/ ${nodesTotal}` : undefined}
              sub={
                clusterError
                  ? inventoryUnavailable
                  : nodesTotal === 0
                  ? intl.formatMessage({ id: "web.routes.dashboard.no_node_data", defaultMessage: "no node data", description: "Dashboard: sub-label on the Nodes ready card when no nodes are reported" })
                  : inventory?.partial
                    ? intl.formatMessage({ id: "web.routes.dashboard.returned_nodes_only", defaultMessage: "returned nodes only", description: "Dashboard: sub-label on the Nodes ready card when the inventory is partial" })
                  : nodesReady === nodesTotal
                    ? intl.formatMessage({ id: "web.routes.dashboard.all_healthy", defaultMessage: "all healthy", description: "Dashboard: sub-label on the Nodes ready card when every node is ready" })
                    : intl.formatMessage({ id: "web.routes.dashboard.nodes_need_attention", defaultMessage: "needs attention", description: "Dashboard: sub-label on the Nodes ready card when some nodes are not ready" })
              }
            />
            <KpiCard
              label={intl.formatMessage({ id: "web.routes.dashboard.disk_used", defaultMessage: "Disk used", description: "Dashboard: label of the summary card with the disk space used on the cluster nodes; the line under it shows the total disk" })}
              icon={HardDrive}
              accent="text-chart-stat"
              value={storage.valueText}
              sub={storage.subText}
            />
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            {countsUnavailable
              ? <ErrorCard message={intl.formatMessage({ id: "web.routes.dashboard.servers_load_failed", defaultMessage: "Couldn't load servers. Status and player totals are unavailable.", description: "Dashboard: error card when the server list cannot be loaded" })} />
              : <FleetStatusCard complete={!fleet?.partial} groups={groups} busiest={busiest} scope={scopeLabel} gameCodes={gameCodes} byName={byName} />}
            <ClusterResourcesCard
              cpu={cpu}
              mem={mem}
              storage={storage}
              storageKnown={storageKnown}
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
                ? <ErrorCard message={intl.formatMessage({ id: "web.routes.dashboard.backups_load_failed", defaultMessage: "Couldn't load backups. Backup status is unavailable.", description: "Dashboard: error card when the backup list cannot be loaded" })} />
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
  const intl = useOptionalIntl();
  const stopped = groups.stopped + groups.other;
  const segments = [
    { n: groups.running, cls: "bg-success" },
    { n: stopped, cls: "bg-muted" },
    { n: groups.failed, cls: "bg-danger" },
  ].filter((s) => s.n > 0);
  const tiles = [
    { label: intl.formatMessage({ id: "web.routes.dashboard.running", defaultMessage: "Running", description: "Dashboard: label of the summary card counting running game servers" }), n: groups.running, cls: "bg-success" },
    { label: intl.formatMessage({ id: "web.routes.dashboard.stopped", defaultMessage: "Stopped", description: "Dashboard: label of the fleet status tile counting stopped game servers" }), n: stopped, cls: "bg-muted" },
    { label: intl.formatMessage({ id: "web.routes.dashboard.failed", defaultMessage: "Failed", description: "Dashboard: label of the fleet status tile counting failed game servers" }), n: groups.failed, cls: "bg-danger" },
  ];
  const attention = groups.attention.slice(0, 4);

  return (
    <Card className="min-w-0 gap-5 border border-border p-5">
      <CardHeader
        title={intl.formatMessage({ id: "web.routes.dashboard.fleet_status", defaultMessage: "Fleet status", description: "Dashboard: heading of the card showing how many game servers are running, stopped or failed and which ones need attention" })}
        sub={complete
          ? intl.formatMessage({ id: "web.routes.dashboard.fleet_status_servers", defaultMessage: "{count, plural, one {# server} other {# servers}} {scope}", description: "Dashboard: subtitle of the Fleet status card with the number of servers and the scope; {count} is the number of servers and {scope} names the selected location or says all locations" }, { count: groups.total, scope })
          : intl.formatMessage({ id: "web.routes.dashboard.fleet_status_returned_servers", defaultMessage: "{count, plural, one {# returned server} other {# returned servers}} {scope}", description: "Dashboard: subtitle of the Fleet status card when only some servers were returned; {count} is the number of returned servers and {scope} names the selected location or says all locations" }, { count: groups.total, scope })}
        action={<CardLink to="/servers">{intl.formatMessage({ id: "web.routes.dashboard.view_servers", defaultMessage: "View servers", description: "Dashboard: link in the Fleet status card to the server list; keep it short" })}</CardLink>}
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
          <SectionLabel>{intl.formatMessage({ id: "web.routes.dashboard.most_players", defaultMessage: "Most players", description: "Dashboard: label above the list of the servers with the most online players in the Fleet status card" })}</SectionLabel>
          {busiest.map((gs) => (
            <PlayerRow key={targetKey(resourceTarget(gs))} gs={gs} gameCodes={gameCodes} byName={byName} />
          ))}
        </div>
      )}

      <div className="space-y-3 border-t border-border pt-5">
        <SectionLabel>{intl.formatMessage({ id: "web.routes.dashboard.needs_attention", defaultMessage: "Needs attention", description: "Dashboard: small uppercase label above the list of up to four servers that need attention in the fleet status card" })}</SectionLabel>
        {attention.length === 0 ? (
          <div className="flex items-center gap-3 rounded-lg bg-success-soft p-3">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-success-soft-foreground">{intl.formatMessage({ id: "web.routes.dashboard.everything_looks_healthy", defaultMessage: "Everything looks healthy", description: "Dashboard: heading of the Needs attention box in the fleet status card when no server needs attention" })}</div>
              <div className="text-xs text-muted">
                {complete
                  ? intl.formatMessage({ id: "web.routes.dashboard.no_failed_servers_or_stale_agents", defaultMessage: "No failed servers or stale agents.", description: "Dashboard: line under Everything looks healthy when the fleet is complete and no server failed or has a stale agent" })
                  : intl.formatMessage({ id: "web.routes.dashboard.no_issues_partial", defaultMessage: "No issues among returned servers; some locations are unavailable.", description: "Dashboard: Needs attention message when the fleet is partial and no returned server needs attention" })}
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
  const intl = useOptionalIntl();
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
        {max ? <span className="text-muted">{intl.formatMessage({ id: "web.routes.dashboard.of_max", defaultMessage: "/ {max}", description: "Dashboard: player slot limit shown after the online player count on a server row, such as / 20; {max} is the maximum player count" }, { max })}</span> : null}
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
  const intl = useOptionalIntl();
  const phase = gs.status?.phase;
  // phaseGroups.attention only ever holds Failed-phase or stale-agent
  // (excluding expected-down) servers, so the reason is one of exactly
  // these two.
  const reason = phase === "Failed"
    ? intl.formatMessage({ id: "web.routes.dashboard.reason_failed", defaultMessage: "Failed — check logs", description: "Dashboard: reason shown on a server that needs attention because it failed" })
    : intl.formatMessage({ id: "web.routes.dashboard.reason_agent_stale", defaultMessage: "Agent heartbeat stale", description: "Dashboard: reason shown on a server whose agent heartbeat is stale" });
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
        <div className="truncate text-[11px] text-muted">{intl.formatMessage({ id: "web.routes.dashboard.target_and_reason", defaultMessage: "{target} · {reason}", description: "Dashboard: line under a server that needs attention; {target} is the cluster and namespace label, {reason} the problem" }, { target: targetLabel(resourceTarget(gs)), reason })}</div>
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
  storageKnown,
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
  storageKnown: boolean;
  storagePct: number;
  nodes: ClusterNode[];
  nodesReady: number;
  nodesTotal: number;
  canViewCluster: boolean;
  network: NetworkUsage;
  cpuAllocation: Allocation;
  memAllocation: Allocation;
}) {
  const intl = useOptionalIntl();
  const emptyValue = intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" });
  const allocationHint = intl.formatMessage({ id: "web.routes.dashboard.allocation_hint", defaultMessage: "Requests are reserved by the scheduler; limits are the most pods may burst to and can exceed capacity.", description: "Dashboard: tooltip and screen-reader text of the info icon next to the Allocation label, explaining that requests are reserved and limits can exceed capacity" });
  return (
    <Card className="min-w-0 gap-5 border border-border p-5">
      <CardHeader
        title={intl.formatMessage({ id: "web.routes.dashboard.cluster_resources", defaultMessage: "Cluster resources", description: "Dashboard: heading of the card showing CPU, memory and storage use across the clusters the user can see" })}
        badge={
          <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success-soft-foreground">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
            {intl.formatMessage({ id: "web.routes.dashboard.live", defaultMessage: "Live", description: "Dashboard: badge in the Cluster resources card header showing that the figures update live" })}
          </span>
        }
        sub={nodesTotal > 0 ? intl.formatMessage({ id: "web.routes.dashboard.usage_and_allocation_across", defaultMessage: "Usage and scheduler allocation across {count, plural, one {# node} other {# nodes}}", description: "Dashboard: subtitle of the Cluster resources card with the number of nodes; {count} is the number of nodes" }, { count: nodesTotal }) : intl.formatMessage({ id: "web.routes.dashboard.usage_and_allocation", defaultMessage: "Usage and scheduler allocation", description: "Dashboard: subtitle of the Cluster resources card when no nodes are reported" })}
        action={
          canViewCluster ? (
            <CardLink to="/clusters">{intl.formatMessage({ id: "web.routes.dashboard.view_clusters", defaultMessage: "View clusters", description: "Dashboard: link at the top right of the cluster resources card that opens the clusters page; keep it short" })}</CardLink>
          ) : (
            <span className="shrink-0 text-xs text-muted">
              {nodesTotal > 0 ? intl.formatMessage({ id: "web.routes.dashboard.nodes_ready_of_total", defaultMessage: "{ready}/{total} nodes ready", description: "Dashboard: node readiness in the Cluster resources card; {ready} and {total} are counts" }, { ready: nodesReady, total: nodesTotal }) : emptyValue}
            </span>
          )
        }
      />

      <div className="grid gap-5 md:grid-cols-2 md:gap-6">
        <div className="min-w-0 space-y-4">
          <SectionLabel>{intl.formatMessage({ id: "web.routes.dashboard.usage", defaultMessage: "Usage", description: "Dashboard: small uppercase label above the usage meters in the Cluster resources card" })}</SectionLabel>
          <Meter label={intl.formatMessage({ id: "web.routes.dashboard.cpu", defaultMessage: "CPU", description: "Dashboard: label of the CPU usage bar in the cluster resources card; CPU is a technical term, usually left untranslated" })} pct={cpu.pct} sub={cpu.sub} unknown={!cpu.known} accent="primary" />
          <Meter label={intl.formatMessage({ id: "web.routes.dashboard.memory", defaultMessage: "Memory", description: "Dashboard: label of the memory usage bar in the cluster resources card" })} pct={mem.pct} sub={mem.sub} unknown={!mem.known} accent="violet" />
          <Meter
            label={intl.formatMessage({ id: "web.routes.dashboard.storage", defaultMessage: "Storage", description: "Dashboard: label of the storage usage bar in the cluster resources card" })}
            pct={storagePct}
            sub={storage.subText}
            unknown={!storageKnown}
            accent="success"
          />
          <div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted">{intl.formatMessage({ id: "web.routes.dashboard.network", defaultMessage: "Network", description: "Dashboard: label of the network throughput line in the cluster resources card" })}</span>
              <span className={cn("font-mono", network.known ? "text-foreground" : "text-muted")}>
                {network.known ? intl.formatMessage({ id: "web.routes.dashboard.network_rate", defaultMessage: "{rate}/s", description: "Dashboard: total network throughput of the cluster in the cluster resources card, such as 1.2 MB/s; {rate} is the formatted byte rate" }, { rate: formatBytes(network.rx + network.tx) }) : emptyValue}
              </span>
            </div>
            <div className="pt-1 text-[10px] text-muted">
              {network.known
                ? intl.formatMessage({ id: "web.routes.dashboard.network_detail", defaultMessage: "In {rx}/s · Out {tx}/s · {count, plural, one {# game server} other {# game servers}}", description: "Dashboard: network throughput detail in the cluster resources card; {rx} and {tx} are formatted byte rates, {count} is the number of game servers reporting traffic" }, { rx: formatBytes(network.rx), tx: formatBytes(network.tx), count: network.servers })
                : intl.formatMessage({ id: "web.routes.dashboard.no_game_server_traffic", defaultMessage: "no game server traffic reported", description: "Dashboard: network line in the cluster resources card when no game server reports traffic" })}
            </div>
          </div>
        </div>
        <div className="min-w-0 space-y-4 border-t border-border pt-5 md:border-l md:border-t-0 md:pl-6 md:pt-0">
          <div className="flex items-center gap-1 text-muted">
            <SectionLabel>{intl.formatMessage({ id: "web.routes.dashboard.allocation", defaultMessage: "Allocation", description: "Dashboard: small uppercase label above the scheduler allocation meters in the Cluster resources card" })}</SectionLabel>
            <span role="img" aria-label={allocationHint} title={allocationHint}>
              <Info className="h-3 w-3" />
            </span>
          </div>
          <Meter label={intl.formatMessage({ id: "web.routes.dashboard.cpu_requested", defaultMessage: "CPU requested", description: "Dashboard: label of the CPU requested meter in the Allocation section" })} pct={cpuAllocation.requestPct} sub={cpuAllocation.requestSub} unknown={!cpuAllocation.known} accent="primary" />
          <Meter label={intl.formatMessage({ id: "web.routes.dashboard.cpu_limits", defaultMessage: "CPU limits", description: "Dashboard: label of the CPU limits meter in the Allocation section" })} pct={cpuAllocation.limitPct} sub={cpuAllocation.limitSub} unknown={!cpuAllocation.known} accent={cpuAllocation.limitPct > 100 ? "warning" : "primary"} />
          <Meter label={intl.formatMessage({ id: "web.routes.dashboard.memory_requested", defaultMessage: "Memory requested", description: "Dashboard: label of the memory requested meter in the Allocation section" })} pct={memAllocation.requestPct} sub={memAllocation.requestSub} unknown={!memAllocation.known} accent="violet" />
          <Meter label={intl.formatMessage({ id: "web.routes.dashboard.memory_limits", defaultMessage: "Memory limits", description: "Dashboard: label of the memory limits meter in the Allocation section" })} pct={memAllocation.limitPct} sub={memAllocation.limitSub} unknown={!memAllocation.known} accent={memAllocation.limitPct > 100 ? "warning" : "violet"} />
        </div>
      </div>

      {nodes.length > 0 && (
        <div className="mt-auto space-y-2 border-t border-border pt-4">
          <SectionLabel>{intl.formatMessage({ id: "web.routes.dashboard.nodes", defaultMessage: "Nodes", description: "Dashboard: small uppercase label above the list of up to four nodes in the cluster resources card" })}</SectionLabel>
          {nodes.slice(0, 4).map((n) => (
            <NodeRow key={n.name} node={n} />
          ))}
        </div>
      )}
    </Card>
  );
}

function NodeRow({ node }: { node: ClusterNode }) {
  const intl = useOptionalIntl();
  const ready = node.status === "Ready";
  const cpuKnown = node.cpu?.used !== undefined;
  const cpuPct = pctOf(node.cpu?.used, node.cpu?.capacity);
  const meta = [
    node.pods?.used !== undefined ? intl.formatMessage({ id: "web.routes.dashboard.node_pods", defaultMessage: "{count} pods", description: "Dashboard: pod count on a node row; {count} is the number of pods" }, { count: node.pods.used }) : null,
    cpuKnown && node.cpu?.capacity ? intl.formatMessage({ id: "web.routes.dashboard.node_cpu", defaultMessage: "cpu {percent}%", description: "Dashboard: CPU usage on a node row; {percent} is the rounded percentage" }, { percent: Math.round(cpuPct) }) : null,
  ]
    .filter(Boolean)
    .join(` ${intl.formatMessage({ id: "web.routes.dashboard.meta_separator", defaultMessage: "·", description: "Separator between items on one line of metadata" })} `);
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", ready ? "bg-success" : "bg-danger")} />
      <span className="min-w-0 flex-1 break-all font-mono text-foreground">{node.name}</span>
      <span className="shrink-0 text-muted">{meta || intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" })}</span>
    </div>
  );
}

function RecentActivityCard({ events }: { events: AuditEvent[] }) {
  const intl = useOptionalIntl();
  return (
    <Card className="min-w-0 gap-5 border border-border p-5">
      <CardHeader
        title={intl.formatMessage({ id: "web.routes.dashboard.recent_activity", defaultMessage: "Recent activity", description: "Dashboard: heading of the card listing the latest audit events; a link to the full audit log sits beside it" })}
        sub={intl.formatMessage({ id: "web.routes.dashboard.central_audit_log_not_filtered", defaultMessage: "Central audit log · not filtered by location", description: "Dashboard: subtitle of the Recent activity card saying it lists the central audit log, which is not filtered by location" })}
        action={<CardLink to="/admin/audit">{intl.formatMessage({ id: "web.routes.dashboard.view_all", defaultMessage: "View all", description: "Dashboard: link in the recent activity card to the full audit log, and in the recent backups card to the backups page; keep it short" })}</CardLink>}
      />
      {events.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted">{intl.formatMessage({ id: "web.routes.dashboard.no_recent_activity", defaultMessage: "No recent activity.", description: "Dashboard: empty-state text in the recent activity card shown when there are no audit events" })}</div>
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
  const intl = useOptionalIntl();
  const { icon: Icon, accent } = actionIcon(event);
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
        <Icon className={cn("h-4 w-4", accent)} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">{describeAudit(intl, event)}</div>
        <div className="truncate font-mono text-[11px] text-muted">
          {event.method} {event.path}
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted">{formatRelative(event.ts, intl)}</span>
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
  const intl = useOptionalIntl();
  return (
    <Card className="min-w-0 gap-5 border border-border p-5">
      <CardHeader
        title={intl.formatMessage({ id: "web.routes.dashboard.recent_backups", defaultMessage: "Recent backups", description: "Dashboard: heading of the card listing the latest backups; a link to the backups page sits beside it" })}
        sub={intl.formatMessage({ id: "web.routes.dashboard.latest_snapshots_in_the_selected", defaultMessage: "Latest snapshots in the selected locations", description: "Dashboard: subtitle of the Recent backups card saying it lists the latest snapshots in the selected locations" })}
        action={<CardLink to="/backups">{intl.formatMessage({ id: "web.routes.dashboard.view_all", defaultMessage: "View all", description: "Dashboard: link in the recent activity card to the full audit log, and in the recent backups card to the backups page; keep it short" })}</CardLink>}
      />
      {backups.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted">{complete
          ? intl.formatMessage({ id: "web.routes.dashboard.no_backups_yet", defaultMessage: "No backups yet.", description: "Dashboard: empty Recent backups card when the backup list is complete" })
          : intl.formatMessage({ id: "web.routes.dashboard.no_backup_data", defaultMessage: "No backup data available.", description: "Dashboard: empty Recent backups card when the backup list is partial" })}</div>
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
  const intl = useOptionalIntl();
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
        <div className="truncate text-[11px] text-muted">{intl.formatMessage({ id: "web.routes.dashboard.target_and_time", defaultMessage: "{target} · {when}", description: "Dashboard: line under a backup; {target} is the cluster and namespace label, {when} the relative time" }, { target: targetLabel(target), when: formatRelative(when, intl) })}</div>
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
function sumUsage(intl: ReturnType<typeof useOptionalIntl>, nodes: ClusterNode[], key: "cpu" | "memory"): Usage {
  const reading = sumNodeUsage(nodes, key);
  if (!reading.known) return { pct: 0, known: false };
  const sub = key === "memory"
    ? intl.formatMessage({ id: "web.routes.dashboard.memory_used_of_capacity", defaultMessage: "{used} / {capacity}", description: "Dashboard: memory usage sub-label on the Cluster resources card; both are formatted byte sizes" }, { used: formatBytes(reading.used), capacity: formatBytes(reading.capacity) })
    : intl.formatMessage({ id: "web.routes.dashboard.cpu_used_of_capacity", defaultMessage: "{used} / {capacity} cores", description: "Dashboard: CPU usage sub-label on the Cluster resources card; both are formatted core counts" }, { used: formatCores(reading.used), capacity: formatCores(reading.capacity) });
  return { pct: reading.pct, sub, known: true };
}

function sumAllocation(intl: ReturnType<typeof useOptionalIntl>, nodes: ClusterNode[], key: "cpu" | "memory"): Allocation {
  const known = nodes.length > 0 && nodes.every((node) => typeof node[key]?.requests === "number" && (node[key]?.capacity ?? 0) > 0);
  if (!known) return UNKNOWN_ALLOCATION;
  const capacity = nodes.reduce((sum, node) => sum + (node[key]?.capacity ?? 0), 0);
  const requests = nodes.reduce((sum, node) => sum + (node[key]?.requests ?? 0), 0);
  const limits = nodes.reduce((sum, node) => sum + (node[key]?.limits ?? 0), 0);
  const format = (value: number) => (key === "memory" ? formatBytes(value) : intl.formatMessage({ id: "web.routes.dashboard.cores_value", defaultMessage: "{cores} cores", description: "Dashboard: CPU amount in the Allocation meters, such as 4 cores; {cores} is the core count" }, { cores: formatCores(value) }));
  const allocationOf = (value: number, total: number) => intl.formatMessage({ id: "web.routes.dashboard.allocation_of_total", defaultMessage: "{value} of {total}", description: "Dashboard: amount under an Allocation meter; {value} is the amount requested or limited and {total} is the capacity, both already formatted" }, { value: format(value), total: format(total) });
  return {
    known: true,
    requestPct: (requests / capacity) * 100,
    limitPct: (limits / capacity) * 100,
    requestSub: allocationOf(requests, capacity),
    limitSub: allocationOf(limits, capacity),
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
const auditVerbs = defineMessages({
  deleted: { id: "web.routes.dashboard.audit_verb_deleted", defaultMessage: "deleted", description: "Dashboard: action word in an activity line for a DELETE request" },
  created: { id: "web.routes.dashboard.audit_verb_created", defaultMessage: "created", description: "Dashboard: action word in an activity line for a POST request" },
  updated: { id: "web.routes.dashboard.audit_verb_updated", defaultMessage: "updated", description: "Dashboard: action word in an activity line for a PUT or PATCH request" },
});

function describeAudit(intl: ReturnType<typeof useOptionalIntl>, e: AuditEvent): string {
  const target = e.target ? ` ${e.target}` : "";
  const actor = e.actor;
  if (e.path.endsWith("/auth/login")) {
    return e.status >= 200 && e.status < 300
      ? intl.formatMessage({ id: "web.routes.dashboard.audit_signed_in", defaultMessage: "{actor} signed in", description: "Dashboard: activity line for a successful sign-in; {actor} is the username" }, { actor })
      : intl.formatMessage({ id: "web.routes.dashboard.audit_failed_sign_in", defaultMessage: "{actor} failed to sign in", description: "Dashboard: activity line for a failed sign-in; {actor} is the username" }, { actor });
  }
  if (e.path.includes(":start")) return intl.formatMessage({ id: "web.routes.dashboard.audit_started", defaultMessage: "{actor} started{target}", description: "Dashboard: activity line for a server start; {actor} is the username, {target} is the audited object preceded by a space, or empty" }, { actor, target });
  if (e.path.includes(":stop")) return intl.formatMessage({ id: "web.routes.dashboard.audit_stopped", defaultMessage: "{actor} stopped{target}", description: "Dashboard: activity line for a server stop; {actor} is the username, {target} is the audited object preceded by a space, or empty" }, { actor, target });
  if (e.path.includes(":restart")) return intl.formatMessage({ id: "web.routes.dashboard.audit_restarted", defaultMessage: "{actor} restarted{target}", description: "Dashboard: activity line for a server restart; {actor} is the username, {target} is the audited object preceded by a space, or empty" }, { actor, target });
  if (e.path.includes("/backups")) return intl.formatMessage({ id: "web.routes.dashboard.audit_backed_up", defaultMessage: "{actor} backed up{target}", description: "Dashboard: activity line for a backup; {actor} is the username, {target} is the audited object preceded by a space, or empty" }, { actor, target });
  if (e.path.includes("/users")) return intl.formatMessage({ id: "web.routes.dashboard.audit_updated_user", defaultMessage: "{actor} updated a user{target}", description: "Dashboard: activity line for a user change; {actor} is the username, {target} is the audited object preceded by a space, or empty" }, { actor, target });
  const verb =
    e.method === "DELETE"
      ? intl.formatMessage(auditVerbs.deleted)
      : e.method === "POST"
        ? intl.formatMessage(auditVerbs.created)
        : e.method === "PUT" || e.method === "PATCH"
          ? intl.formatMessage(auditVerbs.updated)
          : e.method.toLowerCase();
  return intl.formatMessage({ id: "web.routes.dashboard.audit_generic", defaultMessage: "{actor} {verb}{target}", description: "Dashboard: fallback activity line; {actor} is the username, {verb} the action word, {target} the audited object preceded by a space, or empty" }, { actor, verb, target }).trim();
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
