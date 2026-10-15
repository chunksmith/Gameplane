import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ServerActionsMenu } from "@/components/server/ServerActionsMenu";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Cpu,
  Database,
  Filter,
  HardDrive,
  Layers,
  Minus,
  Play,
  Plus,
  RotateCw,
  Search,
  Server as ServerIcon,
  SlidersHorizontal,
  Square,
  Sunrise,
  Trash2,
  Users as UsersIcon,
} from "lucide-react";

import { Button, Card, Input, Chip, ListBox, ListBoxItem, Select, Tabs, Tab, Table, buttonVariants } from "@heroui/react";
import { StatCard } from "@/components/ui/StatCard";
import { PhaseChip } from "@/components/ui/PhaseChip";
import { FilterPopover } from "@/components/ui/FilterPopover";
import { GameIcon } from "@/components/ui/GameIcon";
import { PageHeader } from "@/components/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { describeStorageProvisioned, formatBytes, cn } from "@/lib/utils";
import { useMediaQuery } from "@/lib/media";
import type { GameServer, GameServerPhase, GameTemplate } from "@/types";
import { Networks, Servers, createResourceClient, type LifecycleVerb } from "@/lib/endpoints";
import { NETWORK_ANNOTATION } from "@/lib/annotations";
import { countByState } from "@/lib/servers";
import { groupServers, type ServerGroup } from "@/lib/serverSets";
import { resourceCan } from "@/lib/resourceTarget";
import { useFleetLocation, Fleet, inventoryTotals, playerCoverage, templateKey, useFleetGameCodes, located, resourceTarget, targetKey, targetLabel, targetSearch, useFleetPlacements, useFleetServerSelection, useFleetServerSets, useFleetServers, type FleetTarget, type Located } from "@/lib/fleet";
import { FleetCoverage, FleetScopeFilter } from "@/components/FleetScope";

type FilterKey = "all" | "running" | "stopped";

export function ServersPage() {
  const qc = useQueryClient();
  const { data: placements } = useFleetPlacements();
  const canCreate = (placements?.items.length ?? 0) > 0;
  const [location, setLocation] = useFleetLocation();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [network, setNetwork] = useState("");
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [appliedGames, setAppliedGames] = useState<Set<string>>(new Set());
  const [appliedNamespaces, setAppliedNamespaces] = useState<Set<string>>(new Set());
  const [draftLocation, setDraftLocation] = useState(location);
  const [draftGames, setDraftGames] = useState<Set<string>>(new Set());
  const [draftNamespaces, setDraftNamespaces] = useState<Set<string>>(new Set());

  const { data: scopes } = useFleetServers();
  const { data: fleet, isLoading, error } = useFleetServerSelection(location, appliedNamespaces);
  const { data: setFleet } = useFleetServerSets(location);
  const sets = useMemo(() => (setFleet?.items ?? []).map(located).filter((set) => !location || set.fleetTarget.cluster === location), [setFleet, location]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { data: inventory, error: inventoryError } = useQuery({
    queryKey: ["fleet", "inventory", location],
    queryFn: ({ signal }) => Fleet.inventory({ cluster: location || undefined }, signal),
    staleTime: 30_000,
  });
  const { data: networks } = useQuery({ queryKey: ["networks"], queryFn: () => Networks.list() });
  const allServers = useMemo(() => (fleet?.items ?? []).map(located), [fleet]);
  const servers = useMemo(() => allServers.filter((server) => !location || server.fleetTarget.cluster === location), [allServers, location]);
  const clusterView = inventoryTotals((inventory?.items ?? []).filter((item) => !location || item.cluster === location));
  const cluster = { ...clusterView, nodes: clusterView.total };
  const { gameCodes, byName, templatesByCluster } = useFleetGameCodes(fleet?.items);
  const act = useMutation({
    mutationFn: (args: { target: FleetTarget; verb: LifecycleVerb }) =>
      Servers.lifecycle(args.target.name, args.verb, args.target.namespace, args.target.cluster),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fleet", "servers"] }),
  });

  // Below `md`, a wide table doesn't fit — render stacked cards instead.
  // Driven by matchMedia (not a responsive CSS class toggle) so only one
  // representation of each server ever mounts; two would duplicate every
  // row's accessible text in the DOM.
  const isMobile = useMediaQuery("(max-width: 767px)");


  const counts = useMemo(() => countByState(servers), [servers]);
  const players = playerCoverage(servers);
  const vcpus = (clusterView?.nodes ?? []).reduce((s, n) => s + (n.cpu?.capacity ?? 0), 0);
  const storage = cluster.usedStorageBytes === undefined ? { valueText: "—", subText: "inventory unavailable", overcommitted: false } : describeStorageProvisioned(cluster.usedStorageBytes, cluster.totalStorageBytes);

  // Derive distinct games and namespaces from servers
  const distinctGames = useMemo(() => {
    const games = new Set<string>();
    servers.forEach((s) => {
      games.add(s.spec.templateRef.name);
    });
    return Array.from(games).sort();
  }, [servers]);

  const distinctNamespaces = useMemo(() => {
    const namespaces = new Set([...appliedNamespaces, ...draftNamespaces]);
    for (const scope of scopes?.scopes ?? []) if (scope.namespace) namespaces.add(scope.namespace);
    for (const item of scopes?.items ?? []) namespaces.add(item.target.namespace);
    for (const server of servers) namespaces.add(server.metadata.namespace ?? "gameplane-games");
    return [...namespaces].sort();
  }, [scopes, servers, appliedNamespaces, draftNamespaces]);

  const appliedFacetCount = appliedGames.size + appliedNamespaces.size + (location ? 1 : 0);
  const locationChoices = [...(scopes?.scopes ?? []).map((scope) => scope.cluster), ...(scopes?.items ?? []).map((item) => item.target.cluster), ...(scopes?.issues ?? []).map((issue) => issue.cluster)];
  const locationField = <div className="space-y-1">
    <div className="text-xs font-semibold text-muted">Location</div>
    <FleetScopeFilter value={draftLocation} onChange={setDraftLocation} clusters={locationChoices} />
  </div>;
  const networkSelect = (className: string) => <Select value={network} onChange={(next) => setNetwork(String(next ?? ""))} aria-label="Filter by network" className={className}>
    <Select.Trigger><Select.Value /><Select.Indicator className="ml-auto h-4 w-4" /></Select.Trigger>
    <Select.Popover><ListBox aria-label="Network options">
      <ListBoxItem id="" textValue="All networks">All networks</ListBoxItem>
      {(networks ?? []).map(({ name }) => <ListBoxItem key={name} id={name} textValue={name}>{name}</ListBoxItem>)}
    </ListBox></Select.Popover>
  </Select>;

  const filterServer = (gs: GameServer) => {
    if (query && !gs.metadata.name.toLowerCase().includes(query.toLowerCase())) return false;
    // Facet filters compose with the status tab: evaluate them before the
    // status short-circuit so an active Running/Stopped tab doesn't bypass
    // the applied game/namespace facets.
    if (appliedGames.size > 0 && !appliedGames.has(gs.spec.templateRef.name)) return false;
    const ns = gs.metadata.namespace ?? "gameplane-games";
    if (appliedNamespaces.size > 0 && !appliedNamespaces.has(ns)) return false;
    if (network && gs.metadata.annotations?.[NETWORK_ANNOTATION] !== network) return false;
    const phase = gs.status?.phase;
    if (filter === "running") return phase === "Running";
    if (filter === "stopped") return phase === "Stopped" || phase === "Suspended" || phase === "Failed";
    return true;
  };

  const handleOpenFilterChange = (open: boolean) => {
    setIsFilterOpen(open);
    if (open) {
      setDraftLocation(location);
      setDraftGames(new Set(appliedGames));
      setDraftNamespaces(new Set(appliedNamespaces));
    }
  };

  const handleToggleDraftGame = (game: string) => {
    const newSet = new Set(draftGames);
    if (newSet.has(game)) {
      newSet.delete(game);
    } else {
      newSet.add(game);
    }
    setDraftGames(newSet);
  };

  const handleToggleDraftNamespace = (ns: string) => {
    const newSet = new Set(draftNamespaces);
    if (newSet.has(ns)) {
      newSet.delete(ns);
    } else {
      newSet.add(ns);
    }
    setDraftNamespaces(newSet);
  };

  const handleApplyFilter = () => {
    setLocation(draftLocation);
    setAppliedGames(new Set(draftGames));
    setAppliedNamespaces(new Set(draftNamespaces));
    setIsFilterOpen(false);
  };

  const handleClearFilter = () => {
    setDraftLocation("");
    setDraftGames(new Set());
    setDraftNamespaces(new Set());
  };

  const setMatches = (set: (typeof sets)[number]) =>
    (!query || set.metadata.name.toLowerCase().includes(query.toLowerCase())) &&
    (appliedGames.size === 0 || appliedGames.has(set.spec.template?.templateRef?.name ?? "")) &&
    (appliedNamespaces.size === 0 || appliedNamespaces.has(set.fleetTarget.namespace));
  const grouped = groupServers(servers, sets);
  const standalone = grouped.standalone.filter(filterServer);
  const groups = grouped.groups
    .map((group) => ({ group, shown: group.servers.filter(filterServer) }))
    .filter(({ group, shown }) => shown.length > 0 || (filter === "all" && !network && !!group.set && setMatches(group.set)));
  const toggleGroup = (key: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const groupSection = groups.length > 0 && (
    <section aria-label="Server groups" className="space-y-3">
      {groups.map(({ group, shown }) => (
        <ServerGroupCard
          key={group.key}
          group={group}
          shown={shown}
          expanded={expanded.has(group.key)}
          onToggle={() => toggleGroup(group.key)}
          templates={templatesByCluster.get(group.cluster)}
          gameCodes={gameCodes}
          pending={act.isPending}
          onAct={act.mutate}
        />
      ))}
    </section>
  );

  return (
    <div className="space-y-6 p-6">
      {!isMobile && (
        <PageHeader
          title="Servers"
          subtitle="Manage your game servers across all authorized locations."
          actions={canCreate ?
            <Link to="/servers/new" className={cn(buttonVariants({ variant: "primary" }), "rounded-full")}>
              <Plus className="h-4 w-4" /> Create server
            </Link> : undefined
          }
        />
      )}

      {act.error && <ErrorBanner err={act.error} onDismiss={() => act.reset()} />}
      <FleetCoverage partial={fleet?.partial} issues={fleet?.issues} error={error} label="Server results" />
      <FleetCoverage partial={inventory?.partial} issues={inventory?.issues} error={inventoryError} label="Inventory" />

      {!isMobile && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <StatCard
            label="Running"
            icon={<Activity className="h-4 w-4" />}
            value={error || (fleet?.partial && servers.length === 0) ? "—" : counts.running}
            sub={error || (fleet?.partial && servers.length === 0) ? "server status unavailable" : `of ${servers.length} ${fleet?.partial ? "returned" : "total"}`}
            accent={error || (fleet?.partial && servers.length === 0) ? "warning" : "success"}
          />
          <StatCard
            label="Players online"
            icon={<UsersIcon className="h-4 w-4" />}
            value={error || !players.known || (fleet?.partial && servers.length === 0) ? "—" : counts.players}
            sub={error || !players.known || (fleet?.partial && servers.length === 0) ? "player status unavailable" : players.unknown ? `${players.unknown} server player counts unavailable` : `peak ${counts.playersMax}`}
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
            label="Inventory nodes"
            icon={<ServerIcon className="h-4 w-4" />}
            value={!inventoryError && cluster.nodes > 0 ? cluster.nodes : "—"}
            sub={inventoryError ? "inventory unavailable" : cluster.nodes === 0 ? "no node data" : inventory?.partial ? "returned nodes only" : "authorized inventory nodes"}
            accent="warning"
          />
        </div>
      )}

      {!isMobile && (
        <div className="flex flex-wrap items-center gap-3">
          <Tabs
            selectedKey={filter}
            onSelectionChange={(key) => setFilter(key as FilterKey)}
            variant="secondary"
          >
            <Tabs.List aria-label="Server status filter" className="servers-status-filter">
              <Tab id="all">
                <span className="inline-flex items-center gap-1.5">
                  All
                  <span className="servers-status-filter__count rounded-[4px] bg-foreground/10 px-1.5 py-0.5 text-xs leading-none">
                    {servers.length}
                  </span>
                </span>
              </Tab>
              <Tab id="running">
                <span className="inline-flex items-center gap-1.5">
                  Running
                  <span className="servers-status-filter__count rounded-[4px] bg-foreground/10 px-1.5 py-0.5 text-xs leading-none">
                    {counts.running}
                  </span>
                </span>
              </Tab>
              <Tab id="stopped">
                <span className="inline-flex items-center gap-1.5">
                  Stopped
                  <span className="servers-status-filter__count rounded-[4px] bg-foreground/10 px-1.5 py-0.5 text-xs leading-none">
                    {counts.stopped}
                  </span>
                </span>
              </Tab>
            </Tabs.List>
          </Tabs>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/60" />
              <Input
                placeholder="Search servers…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full pl-9"
                aria-label="Search servers"
              />
            </div>
            {networkSelect("w-48")}
            <FilterPopover
              fields={locationField}
              games={distinctGames}
              selectedGames={draftGames}
              onToggleGame={handleToggleDraftGame}
              namespaces={distinctNamespaces}
              selectedNamespaces={draftNamespaces}
              onToggleNamespace={handleToggleDraftNamespace}
              onApply={handleApplyFilter}
              onClear={handleClearFilter}
              isOpen={isFilterOpen}
              onOpenChange={handleOpenFilterChange}
            >
              <div className="inline-flex items-center gap-2 rounded-[6px] px-3 py-2 text-sm font-medium border border-default-300 bg-default-100 hover:bg-default-200 cursor-pointer transition-colors">
                <Filter className="h-4 w-4" />
                Filter
                {appliedFacetCount > 0 && (
                  <Chip size="sm" variant="soft" className="ml-1.5">
                    {appliedFacetCount}
                  </Chip>
                )}
              </div>
            </FilterPopover>
          </div>
        </div>
      )}

      {isMobile && (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/60" />
            <Input
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-9 rounded-xl"
              aria-label="Search servers"
            />
          </div>
          {networkSelect("w-36 shrink-0")}
          <FilterPopover
            fields={locationField}
            games={distinctGames}
            selectedGames={draftGames}
            onToggleGame={handleToggleDraftGame}
            namespaces={distinctNamespaces}
            selectedNamespaces={draftNamespaces}
            onToggleNamespace={handleToggleDraftNamespace}
            onApply={handleApplyFilter}
            onClear={handleClearFilter}
            isOpen={isFilterOpen}
            onOpenChange={handleOpenFilterChange}
          >
            <div className="filter-trigger relative inline-flex items-center justify-center w-10 h-10 rounded-xl border border-default-300 bg-default-100 hover:bg-default-200 cursor-pointer">
              <span className="sr-only">Filter</span>
              <SlidersHorizontal className="h-[18px] w-[18px]" />
              {appliedFacetCount > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-accent px-1 text-[10px] text-accent-foreground">{appliedFacetCount}</span>}
            </div>
          </FilterPopover>
        </div>
      )}

      {isMobile ? (
        <div className="space-y-3">
          {groupSection}
          {isLoading && (
            <Card className="p-10 text-center text-sm text-foreground/60">Loading…</Card>
          )}
          {!isLoading && standalone.length === 0 && groups.length === 0 && (
            <Card className="p-12 text-center text-sm text-foreground/60">{error || fleet?.partial ? "No server data available for this filter." : "No servers match."}</Card>
          )}
          {standalone.map((gs) => (
            <ServerCard
              key={targetKey(resourceTarget(gs))}
              gs={gs}
              templates={templatesByCluster.get(resourceTarget(gs).cluster)}
              gameCodes={gameCodes}
            />
          ))}


        </div>
      ) : (
        <div className="space-y-4">
          {groupSection}
          {(standalone.length > 0 || groups.length === 0) && (
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <Table.Root className="bg-transparent">
              <Table.ScrollContainer>
                <Table.Content aria-label="Server list" keyboardNavigationBehavior="arrow">
                  <Table.Header>
                    <Table.Column id="name" isRowHeader>Name</Table.Column>
                    <Table.Column id="game">Game</Table.Column>
                    <Table.Column id="status">Status</Table.Column>
                    <Table.Column id="cpu">CPU</Table.Column>
                    <Table.Column id="memory">Memory</Table.Column>
                    <Table.Column id="players">Players</Table.Column>
                    <Table.Column id="node">Node</Table.Column>
                    <Table.Column id="actions" className="text-right">Actions</Table.Column>
                  </Table.Header>
                  <Table.Body
                    renderEmptyState={() => (
                      <div className="text-center py-10 text-foreground/60">
                        {isLoading ? "Loading…" : error || fleet?.partial ? "No server data available for this filter." : "No servers match."}
                      </div>
                    )}
                  >
                {standalone.map((gs) => (
                  <Table.Row key={targetKey(resourceTarget(gs))}>
                    <Table.Cell>
                      <div className="group relative flex min-w-0 items-center gap-3">
                        <GameIcon
                          game={gs.spec.templateRef.name}
                          icon={byName.get(templateKey(resourceTarget(gs).cluster, gs.spec.templateRef.name))?.spec.icon}
                          code={gameCodes.get(templateKey(resourceTarget(gs).cluster, gs.spec.templateRef.name))}
                          size="sm"
                        />
                        <div className="min-w-0">
                          <Link
                            to="/servers/$name"
                            params={{ name: gs.metadata.name }}
                            search={targetSearch(resourceTarget(gs))}
                            className="block truncate font-mono text-sm text-foreground after:absolute after:inset-0 group-hover:text-primary"
                          >
                            {gs.metadata.name}
                          </Link>
                          <div className="truncate text-xs text-muted">{targetLabel(resourceTarget(gs))}</div>
                        </div>
                      </div>
                    </Table.Cell>
                    <Table.Cell>{gs.spec.templateRef.name}</Table.Cell>
                    <Table.Cell>
                      {(() => {
                        const { phase, asleep } = serverRowData(gs);
                        return <PhaseChip phase={phase} asleep={asleep} />;
                      })()}
                    </Table.Cell>
                    <Table.Cell>
                      {(() => {
                        const { cpuLabel } = serverRowData(gs);
                        return <span className="font-mono">{cpuLabel}</span>;
                      })()}
                    </Table.Cell>
                    <Table.Cell>
                      {(() => {
                        const { memLabel } = serverRowData(gs);
                        return <span className="font-mono">{memLabel}</span>;
                      })()}
                    </Table.Cell>
                    <Table.Cell>
                      {(() => {
                        const { playersLabel } = serverRowData(gs);
                        return <span className="font-mono">{playersLabel}</span>;
                      })()}
                    </Table.Cell>
                    <Table.Cell>
                      {(() => {
                        const { node } = serverRowData(gs);
                        return <span className="font-mono text-foreground/60">{node ?? "—"}</span>;
                      })()}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {(() => {
                        const { phase, asleep } = serverRowData(gs);
                        return <ServerLifecycleActions gs={gs} phase={phase} asleep={asleep} pending={act.isPending} onAct={act.mutate} />;
                      })()}
                    </Table.Cell>
                  </Table.Row>
                ))}

                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table.Root>
          </div>
          )}
        </div>
      )}
    </div>
  );
}

// serverRowData derives the small set of display values ServerRow and
// ServerCard both need (CPU/memory %, player count, shared-read-only flag)
// so the mobile card list can't silently drift from the desktop table's
// formatting.
function serverRowData(gs: GameServer) {
  const phase = gs.status?.phase;
  // The operator reports Stopping (not Suspended) for the whole graceful-
  // drain window even after status.idle.asleep flips true — players may
  // still be connected. Excluding Stopping keeps a draining server's badge
  // honest and keeps Wake from appearing while it's still shutting down.
  const asleep = gs.status?.idle?.asleep === true && phase !== "Stopping";
  const agent = gs.status?.agent;
  const players = agent?.playersOnline;
  const maxPlayers = agent?.playersMax;
  const node = gs.metadata.annotations?.["gameplane.local/node"];
  // Non-default-namespace rows need `?ns=` on the mobile ServerCard's
  // detail link (the desktop table computes the same thing inline at each
  // Link's `search` prop). Lifecycle actions no longer skip these rows —
  // `act`'s mutationFn now carries the row's own namespace (F-130).
  const isSharedNonDefault =
    !!gs.metadata.namespace && gs.metadata.namespace !== "gameplane-games";

  // Resource usage comes from the agent's heartbeat (cgroup + statfs).
  // null/undefined means "unknown" (unreadable source, or a stale heartbeat
  // the API blanked) — render "—", not a misleading 0. Mirrors Overview.tsx.
  const cpuKnown = typeof agent?.cpuMillicores === "number";
  const cpuMilli = cpuKnown ? (agent?.cpuMillicores as number) : 0;
  const cpuLimitMilli =
    typeof agent?.cpuLimitMillicores === "number" ? (agent?.cpuLimitMillicores as number) : 0;
  const cpuLabel = cpuKnown
    ? cpuLimitMilli
      ? `${((cpuMilli / cpuLimitMilli) * 100).toFixed(0)}%`
      : `${(cpuMilli / 1000).toFixed(2)} cores`
    : "—";

  const memKnown = typeof agent?.memoryBytes === "number";
  const memUsed = memKnown ? (agent?.memoryBytes as number) : 0;
  const memLimit =
    typeof agent?.memoryLimitBytes === "number" ? (agent?.memoryLimitBytes as number) : 0;
  const memLabel = memKnown
    ? memLimit
      ? `${((memUsed / memLimit) * 100).toFixed(0)}%`
      : formatBytes(memUsed)
    : "—";

  const playersLabel =
    typeof players === "number" && players >= 0
      ? typeof maxPlayers === "number" && maxPlayers >= 0
        ? `${players}/${maxPlayers}`
        : `${players}`
      : "—";

  return { phase, asleep, node, isSharedNonDefault, cpuLabel, memLabel, playersLabel };
}

// ServerLifecycleActions is the Start/Stop/Restart/menu cluster shared by
// the desktop table row and the mobile card.
function ServerLifecycleActions({
  gs,
  phase,
  asleep,
  onAct,
  pending,
}: {
  gs: Located<GameServer>;
  phase?: GameServerPhase;
  asleep?: boolean;
  pending: boolean;
  onAct: (args: { target: FleetTarget; verb: LifecycleVerb }) => void;
}) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["fleet", "servers"] });
  };
  return (
    <div className="inline-flex items-center">
      {asleep ? (
        <ActionButton
          title="Wake"
          disabled={pending || !gs.fleetAccess?.canControl}
          onClick={() => onAct({ target: gs.fleetTarget, verb: "wake" })}
        >
          <Sunrise className="h-4 w-4" />
        </ActionButton>
      ) : (
        <ActionButton
          title="Start"
          disabled={pending || !gs.fleetAccess?.canControl || phase === "Running" || phase === "Starting"}
          onClick={() => onAct({ target: gs.fleetTarget, verb: "start" })}
        >
          <Play className="h-4 w-4" />
        </ActionButton>
      )}
      <ActionButton
        title="Stop"
        // An asleep server is phase Suspended, but :stop is still a real
        // action there — it patches spec.suspend=true, which the operator
        // honors immediately, distinct from an idle sleep a wake window
        // would otherwise resurrect.
        disabled={pending || !gs.fleetAccess?.canControl || (!asleep && (phase === "Stopped" || phase === "Suspended"))}
        onClick={() => onAct({ target: gs.fleetTarget, verb: "stop" })}
      >
        <Square className="h-4 w-4" />
      </ActionButton>
      <ActionButton
        title="Restart"
        disabled={pending || !gs.fleetAccess?.canControl}
        onClick={() => onAct({ target: gs.fleetTarget, verb: "restart" })}
      >
        <RotateCw className="h-4 w-4" />
      </ActionButton>
      <ServerActionsMenu gs={gs} target={gs.fleetTarget} access={gs.fleetAccess ? { ...gs.fleetAccess, permissions: gs.fleetPermissions } : undefined} onDeleted={invalidate} onTransferred={invalidate} size="sm" className="text-foreground/60 hover:text-foreground" />
    </div>
  );
}


function ServerGroupCard({
  group,
  shown,
  expanded,
  onToggle,
  templates,
  gameCodes,
  pending,
  onAct,
}: {
  group: ServerGroup;
  shown: Located<GameServer>[];
  expanded: boolean;
  onToggle: () => void;
  templates?: GameTemplate[];
  gameCodes: Map<string, string>;
  pending: boolean;
  onAct: (args: { target: FleetTarget; verb: LifecycleVerb }) => void;
}) {
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const client = useMemo(() => createResourceClient({ cluster: group.cluster, namespace: group.namespace }), [group.cluster, group.namespace]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["fleet"] });
  const scale = useMutation({
    mutationFn: (replicas: number) => group.set ? client.ServerSets.scale(group.name, replicas) : Promise.reject(new Error("Group unavailable")),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => client.ServerSets.remove(group.name),
    onSuccess: async () => {
      setConfirmDelete(false);
      await refresh();
    },
  });
  const game = group.set?.spec.template?.templateRef?.name ?? group.servers[0]?.spec.templateRef.name ?? "";
  const desired = group.set?.spec.replicas ?? group.servers.length;
  const ready = group.servers.filter((gs) => gs.status?.phase === "Running").length;
  const players = group.servers.reduce((sum, gs) => sum + Math.max(0, gs.status?.agent?.playersOnline ?? 0), 0);
  const nodes = new Set(group.servers.map((gs) => gs.metadata.annotations?.["gameplane.local/node"]).filter(Boolean)).size;
  const canWrite = !!group.set && resourceCan(group.set.fleetPermissions, "servers:write");
  const busy = scale.isPending || remove.isPending;
  return (
    <Card className="overflow-hidden border border-border bg-card p-0">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} group ${group.name}`}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-primary"
        >
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-muted" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted" />}
          <GameIcon
            game={game}
            icon={templates?.find((template) => template.metadata.name === game)?.spec.icon}
            code={gameCodes.get(templateKey(group.cluster, game))}
            size="sm"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-sm text-foreground">{group.name}</span>
              <Chip size="sm" variant="soft"><Layers className="h-3 w-3" /> Group</Chip>
            </div>
            <div className="truncate text-xs text-muted">{targetLabel(group)} · {game}</div>
          </div>
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <StatChip icon={<Activity className="h-3.5 w-3.5" />} value={`${ready}/${desired} ready`} />
          <StatChip icon={<UsersIcon className="h-3.5 w-3.5" />} value={players} />
          <StatChip icon={<ServerIcon className="h-3.5 w-3.5" />} value={`${nodes} ${nodes === 1 ? "node" : "nodes"}`} />
          {canWrite && (
            <div className="inline-flex items-center rounded-full border border-border">
              <ActionButton title="Remove replica" disabled={busy || desired <= 0} onClick={() => scale.mutate(desired - 1)}>
                <Minus className="h-4 w-4" />
              </ActionButton>
              <span className="min-w-6 text-center font-mono text-sm" aria-label="Replicas">{desired}</span>
              <ActionButton title="Add replica" disabled={busy || desired >= 100} onClick={() => scale.mutate(desired + 1)}>
                <Plus className="h-4 w-4" />
              </ActionButton>
            </div>
          )}
          {canWrite && (
            <ActionButton title="Delete group" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4" />
            </ActionButton>
          )}
        </div>
      </div>
      {(scale.error || remove.error) && (
        <div className="px-4 pb-4">
          <ErrorBanner err={scale.error ?? remove.error} onDismiss={() => { scale.reset(); remove.reset(); }} />
        </div>
      )}
      {expanded && (
        <div className="grid gap-3 border-t border-border p-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.length === 0 && <div className="text-sm text-muted">No replicas running.</div>}
          {shown.map((gs) => {
            const { phase, asleep, node } = serverRowData(gs);
            return (
              <ServerCard
                key={targetKey(resourceTarget(gs))}
                gs={gs}
                templates={templates}
                gameCodes={gameCodes}
                footer={
                  <div className="flex items-center justify-between gap-2">
                    <StatChip icon={<ServerIcon className="h-3.5 w-3.5" />} value={node ?? "—"} />
                    <ServerLifecycleActions gs={gs} phase={phase} asleep={asleep} pending={pending} onAct={onAct} />
                  </div>
                }
              />
            );
          })}
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete group ${group.name}?`}
        description={`This deletes the group and all ${desired} of its servers.`}
        confirmLabel="Delete group"
        destructive
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </Card>
  );
}

// ServerCard is the mobile (< md) stand-in for a table row: compact card
// with name, address, game, status pill, and players/memory chips.
function ServerCard({
  gs,
  templates,
  gameCodes,
  footer,
}: {
  gs: GameServer;
  templates?: GameTemplate[];
  gameCodes: Map<string, string>;
  footer?: ReactNode;
}) {
  const { phase, asleep, memLabel, playersLabel } = serverRowData(gs);

  // Extract address from the first endpoint, if available
  const endpoint = gs.status?.endpoints?.[0];
  const address = endpoint ? `${endpoint.host}:${endpoint.port}` : "—";

  return (
    <Card className="border border-border bg-card p-3.5">
      {/* Row 1: Icon + Name + Address on left, Status pill on right */}
      <div className="flex items-start justify-between gap-3">
        <div className="group relative flex min-w-0 items-center gap-3">
          <GameIcon
            game={gs.spec.templateRef.name}
            icon={templates?.find((t) => t.metadata.name === gs.spec.templateRef.name)?.spec.icon}
            code={gameCodes.get(templateKey(resourceTarget(gs).cluster, gs.spec.templateRef.name))}
            size="sm"
          />
          <div className="min-w-0">
            <Link
              to="/servers/$name"
              params={{ name: gs.metadata.name }}
              search={targetSearch(resourceTarget(gs))}
              className="block truncate text-sm font-medium text-foreground after:absolute after:inset-0 group-hover:text-primary"
            >
              {gs.metadata.name}
            </Link>
            <div className="truncate text-xs text-muted">{targetLabel(resourceTarget(gs))}</div>
            <div className="truncate text-xs text-foreground/60 font-mono">
              {address}
            </div>
          </div>
        </div>
        <PhaseChip phase={phase} asleep={asleep} className="px-1 py-0.5 text-[11px] font-medium rounded-2xl" />
      </div>

      {/* Row 2: Game label */}
      <div className="mt-2 text-sm text-foreground/60">
        {gs.spec.templateRef.name}
      </div>

      {/* Row 3: Two chips - Players and Memory */}
      <div className="mt-3 flex flex-wrap gap-2">
        <StatChip icon={<UsersIcon className="h-3.5 w-3.5" />} value={playersLabel} />
        <StatChip icon={<Database className="h-3.5 w-3.5" />} value={memLabel} />
      </div>

      {footer && <div className="relative z-10 mt-3">{footer}</div>}
    </Card>
  );
}

function StatChip({ icon, value }: { icon: ReactNode; value: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border px-3.5 py-1.5 text-[12px] text-muted">
      {icon}
      <span className="font-mono">{value}</span>
    </span>
  );
}

function ActionButton({
  children, title, onClick, disabled,
}: {
  children: ReactNode;
  title: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      isIconOnly
      variant="ghost"
      aria-label={title}
      onPress={onClick}
      isDisabled={disabled}
      size="sm"
      className="text-foreground/60 hover:text-foreground"
    >
      <span title={title}>{children}</span>
    </Button>
  );
}
