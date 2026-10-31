import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ServerActionsMenu } from "@/components/server/ServerActionsMenu";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Database,
  Filter,
  GripVertical,
  HardDrive,
  Layers,
  Minus,
  Play,
  Plus,
  RotateCw,
  Search,
  Server as ServerIcon,
  SlidersHorizontal,
  Skull,
  Square,
  Sunrise,
  Trash2,
  Users as UsersIcon,
} from "lucide-react";

import { Button, Card, Input, Chip, ListBox, ListBoxItem, Select, Tabs, Tab, Table, buttonVariants } from "@heroui/react";
import { DropIndicator, useDragAndDrop } from "react-aria-components";
import { StatCard } from "@/components/ui/StatCard";
import { PhaseChip } from "@/components/ui/PhaseChip";
import { FilterPopover } from "@/components/ui/FilterPopover";
import { GameIcon } from "@/components/ui/GameIcon";
import { PageHeader } from "@/components/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { describeDiskUsage, formatBytes, formatCpuPercent, formatUptime, cn } from "@/lib/utils";
import { useMediaQuery } from "@/lib/media";
import type { GameServer, GameServerPhase, GameTemplate } from "@/types";
import { Networks, Servers, createResourceClient, type LifecycleVerb } from "@/lib/endpoints";
import { NETWORK_ANNOTATION, PRIORITY_ANNOTATION } from "@/lib/annotations";
import { byPriority, countByState, reorderPriorities } from "@/lib/servers";
import { groupServers, type ServerGroup } from "@/lib/serverSets";
import { resourceCan } from "@/lib/resourceTarget";
import { useFleetLocation, Fleet, inventoryTotals, playerCoverage, templateKey, useFleetGameCodes, located, resourceTarget, targetKey, targetLabel, targetSearch, useFleetPlacements, useFleetServerSelection, useFleetServerSets, useFleetServers, type FleetItem, type FleetResult, type FleetTarget, type Located } from "@/lib/fleet";
import { FleetCoverage, FleetScopeFilter } from "@/components/FleetScope";
import { useOptionalIntl } from "@/lib/i18n/format";
import { defineMessages, type MessageDescriptor } from "react-intl";

type FilterKey = "all" | "running" | "stopped";

const RUNNING_SUB_LABELS = defineMessages({
  ofReturned: { id: "web.routes.servers.of_returned", defaultMessage: "of {count} returned", description: "Servers: sub-label on the Running card when the server list is partial; {count} is the number of returned servers" },
  ofTotal: { id: "web.routes.servers.of_total", defaultMessage: "of {count} total", description: "Servers: sub-label on the Running card; {count} is the total number of servers" },
});

export function ServersPage() {
  const intl = useOptionalIntl();
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
  const runningSubLabel: MessageDescriptor = fleet?.partial ? RUNNING_SUB_LABELS.ofReturned : RUNNING_SUB_LABELS.ofTotal;
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
  const reorder = useMutation({
    mutationFn: (changes: [Located<GameServer>, number][]) =>
      Promise.all(changes.map(([gs, priority]) => Servers.setPriority(gs.metadata.name, priority, gs.fleetTarget.namespace, gs.fleetTarget.cluster))),
    onMutate: async (changes) => {
      await qc.cancelQueries({ queryKey: ["fleet", "servers"] });
      const priorities = new Map(changes.map(([gs, priority]) => [targetKey(gs.fleetTarget), String(priority)]));
      qc.setQueriesData<FleetResult<FleetItem<GameServer>>>({ queryKey: ["fleet", "servers"] }, (data) => data && {
        ...data,
        items: data.items.map((item) => {
          const priority = priorities.get(targetKey(item.target));
          if (priority === undefined) return item;
          const { metadata } = item.resource;
          return { ...item, resource: { ...item.resource, metadata: { ...metadata, annotations: { ...metadata.annotations, [PRIORITY_ANNOTATION]: priority } } } };
        }),
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["fleet", "servers"] }),
  });

  // Below `md`, a wide table doesn't fit — render stacked cards instead.
  // Driven by matchMedia (not a responsive CSS class toggle) so only one
  // representation of each server ever mounts; two would duplicate every
  // row's accessible text in the DOM.
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [tableBox, setTableBox] = useState<HTMLDivElement | null>(null);
  const [fit, setFit] = useState({ width: 0, compact: 0 });
  useEffect(() => {
    const table = tableBox?.querySelector("table");
    const scroller = table?.parentElement;
    if (!table || !scroller) return;
    const observer = new ResizeObserver(() => {
      const width = scroller.clientWidth;
      const overflow = scroller.scrollWidth > width;
      setFit((prev) => prev.width !== width
        ? { width, compact: prev.compact === 0 && overflow ? 1 : 0 }
        : overflow && prev.compact < 2 ? { width, compact: prev.compact + 1 } : prev);
    });
    observer.observe(scroller);
    observer.observe(table);
    return () => observer.disconnect();
  }, [tableBox]);

  const counts = useMemo(() => countByState(servers), [servers]);
  const players = playerCoverage(servers);
  const vcpus = (clusterView?.nodes ?? []).reduce((s, n) => s + (n.cpu?.capacity ?? 0), 0);
  const emptyValue = intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" });
  const inventoryUnavailable = intl.formatMessage({ id: "web.routes.servers.inventory_unavailable", defaultMessage: "inventory unavailable", description: "Servers: sub-label on the storage and inventory-nodes cards when inventory cannot be read" });
  const diskUnknown = !inventoryError && cluster.nodes > 0
    ? intl.formatMessage({ id: "web.routes.servers.disk_needs_prometheus", defaultMessage: "needs Prometheus", description: "Servers: sub-label on the disk card when disk usage cannot be measured because Prometheus is not connected" })
    : inventoryUnavailable;
  const storage = cluster.disk ? describeDiskUsage(cluster.disk.used, cluster.disk.total, intl) : { valueText: emptyValue, subText: diskUnknown };

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
    <div className="text-xs font-semibold text-muted">{intl.formatMessage({ id: "web.routes.servers.location", defaultMessage: "Location", description: "Servers: label of the location filter in the filter panel; the choices are the clusters the user can access" })}</div>
    <FleetScopeFilter value={draftLocation} onChange={setDraftLocation} clusters={locationChoices} />
  </div>;
  const allNetworksLabel = intl.formatMessage({ id: "web.routes.servers.all_networks", defaultMessage: "All networks", description: "Servers: network filter choice that shows servers on every network; keep it short" });
  const networkSelect = (className: string) => <Select value={network} onChange={(next) => setNetwork(String(next ?? ""))} aria-label={intl.formatMessage({ id: "web.routes.servers.filter_by_network", defaultMessage: "Filter by network", description: "Servers: accessible name of the network filter dropdown above the server list; keep it short" })} className={className}>
    <Select.Trigger><Select.Value /><Select.Indicator className="ml-auto h-4 w-4" /></Select.Trigger>
    <Select.Popover><ListBox aria-label={intl.formatMessage({ id: "web.routes.servers.network_options", defaultMessage: "Network options", description: "Servers: hidden name of the list of networks inside the network filter dropdown, read only by screen readers" })}>
      <ListBoxItem id="" textValue={allNetworksLabel}>{allNetworksLabel}</ListBoxItem>
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
  const standalone = grouped.standalone.filter(filterServer).sort(byPriority);
  const { dragAndDropHooks } = useDragAndDrop({
    getItems: (keys) => [...keys].map((key) => ({ "text/plain": String(key) })),
    onReorder: ({ keys, target }) => {
      const [key] = keys;
      const moved = standalone.find((gs) => targetKey(resourceTarget(gs)) === key);
      const anchor = standalone.find((gs) => targetKey(resourceTarget(gs)) === target.key);
      const changes = moved && anchor ? reorderPriorities(standalone, moved, anchor, target.dropPosition === "after") : [];
      if (changes.length) reorder.mutate(changes);
    },
    renderDropIndicator: (target) => <DropIndicator target={target} className="data-[drop-target]:outline-2 data-[drop-target]:outline-accent" />,
  });
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
    <section aria-label={intl.formatMessage({ id: "web.routes.servers.server_groups", defaultMessage: "Server groups", description: "Servers: hidden name of the section that lists server groups above the server list, read only by screen readers" })} className="space-y-3">
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
          title={intl.formatMessage({ id: "web.routes.servers.servers", defaultMessage: "Servers", description: "Servers: page title of the server list page; keep it short" })}
          subtitle={intl.formatMessage({ id: "web.routes.servers.manage_your_game_servers_across_all", defaultMessage: "Manage your game servers across all authorized locations.", description: "Servers: subtitle under the page title saying the list covers game servers in all locations the user may access" })}
          actions={canCreate ?
            <Link to="/servers/new" className={cn(buttonVariants({ variant: "primary" }), "rounded-full")}>
              <Plus className="h-4 w-4" /> {intl.formatMessage({ id: "web.routes.servers.create_server", defaultMessage: "Create server", description: "Servers: button at the top right that opens the form to create a new game server; shown only to users who can create servers; keep it short" })}</Link> : undefined
          }
        />
      )}

      {act.error && <ErrorBanner err={act.error} onDismiss={() => act.reset()} />}
      {reorder.error && <ErrorBanner err={reorder.error} onDismiss={() => reorder.reset()} />}
      <FleetCoverage partial={fleet?.partial} issues={fleet?.issues} error={error} label={intl.formatMessage({ id: "web.routes.servers.server_results", defaultMessage: "Server results", description: "Servers: label of the coverage status for the server data behind the list; it warns when the data is partial or failed" })} />
      <FleetCoverage partial={inventory?.partial} issues={inventory?.issues} error={inventoryError} label={intl.formatMessage({ id: "web.routes.servers.inventory", defaultMessage: "Inventory", description: "Servers: label of the coverage status for the cluster inventory data; it warns when the inventory is partial or failed" })} />

      {!isMobile && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <StatCard
            label={intl.formatMessage({ id: "web.routes.servers.running", defaultMessage: "Running", description: "Servers: 'Running' is both a summary card label counting running servers and a status filter tab that lists them with their count; keep it short" })}
            icon={<Activity className="h-4 w-4" />}
            value={error || (fleet?.partial && servers.length === 0) ? emptyValue : counts.running}
            sub={error || (fleet?.partial && servers.length === 0)
              ? intl.formatMessage({ id: "web.routes.servers.server_status_unavailable", defaultMessage: "server status unavailable", description: "Servers: sub-label on the Running card when server data cannot be read" })
              : intl.formatMessage(runningSubLabel, { count: servers.length })}
            accent={error || (fleet?.partial && servers.length === 0) ? "warning" : "success"}
          />
          <StatCard
            label={intl.formatMessage({ id: "web.routes.servers.players_online", defaultMessage: "Players online", description: "Servers: label of the summary card for players online; the line under the number shows the peak or a note when counts are unavailable" })}
            icon={<UsersIcon className="h-4 w-4" />}
            value={error || !players.known || (fleet?.partial && servers.length === 0) ? emptyValue : counts.players}
            sub={error || !players.known || (fleet?.partial && servers.length === 0)
              ? intl.formatMessage({ id: "web.routes.servers.player_status_unavailable", defaultMessage: "player status unavailable", description: "Servers: sub-label on the Players online card when player counts cannot be read" })
              : players.unknown
                ? intl.formatMessage({ id: "web.routes.servers.player_counts_unavailable", defaultMessage: "{count} server player counts unavailable", description: "Servers: sub-label on the Players online card when some servers report no player count; {count} is how many" }, { count: players.unknown })
                : intl.formatMessage({ id: "web.routes.servers.peak_players", defaultMessage: "peak {count}", description: "Servers: sub-label on the Players online card with the peak player count; {count} is the peak" }, { count: counts.playersMax })}
            accent="primary"
          />
          <StatCard
            label={intl.formatMessage({ id: "web.routes.servers.vcpus", defaultMessage: "vCPUs", description: "Servers: label of the summary card with the total vCPU count; vCPU is a technical term, usually left untranslated" })}
            icon={<Cpu className="h-4 w-4" />}
            value={vcpus > 0 ? vcpus : emptyValue}
            sub={inventory?.partial
              ? intl.formatMessage({ id: "web.routes.servers.returned_inventory_cores", defaultMessage: "returned inventory cores", description: "Servers: sub-label on the vCPUs card when the inventory is partial" })
              : intl.formatMessage({ id: "web.routes.servers.authorized_inventory_cores", defaultMessage: "authorized inventory cores", description: "Servers: sub-label on the vCPUs card" })}
            accent="warning"
          />
          <StatCard
            label={intl.formatMessage({ id: "web.routes.servers.disk_used", defaultMessage: "Disk used", description: "Servers: label of the summary card with the disk space used on the cluster nodes; the line under it shows the total disk" })}
            icon={<HardDrive className="h-4 w-4" />}
            value={storage.valueText}
            sub={storage.subText}
            accent="violet"
          />
          <StatCard
            label={intl.formatMessage({ id: "web.routes.servers.inventory_nodes", defaultMessage: "Inventory nodes", description: "Servers: label of the summary card counting the nodes in the cluster inventory" })}
            icon={<ServerIcon className="h-4 w-4" />}
            value={!inventoryError && cluster.nodes > 0 ? cluster.nodes : emptyValue}
            sub={inventoryError
              ? inventoryUnavailable
              : cluster.nodes === 0
                ? intl.formatMessage({ id: "web.routes.servers.no_node_data", defaultMessage: "no node data", description: "Servers: sub-label on the inventory-nodes card when no nodes are reported" })
                : inventory?.partial
                  ? intl.formatMessage({ id: "web.routes.servers.returned_nodes_only", defaultMessage: "returned nodes only", description: "Servers: sub-label on the inventory-nodes card when the inventory is partial" })
                  : intl.formatMessage({ id: "web.routes.servers.authorized_inventory_nodes", defaultMessage: "authorized inventory nodes", description: "Servers: sub-label on the inventory-nodes card" })}
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
            <Tabs.List aria-label={intl.formatMessage({ id: "web.routes.servers.server_status_filter", defaultMessage: "Server status filter", description: "Servers: hidden name of the row of status filter tabs, read only by screen readers" })} className="servers-status-filter">
              <Tab id="all">
                <span className="inline-flex items-center gap-1.5">{intl.formatMessage({ id: "web.routes.servers.all", defaultMessage: "All", description: "Servers: status filter tab that shows all servers, followed by their count; keep it short" })}<span className="servers-status-filter__count rounded-[4px] bg-foreground/10 px-1.5 py-0.5 text-xs leading-none">
                    {servers.length}
                  </span>
                </span>
              </Tab>
              <Tab id="running">
                <span className="inline-flex items-center gap-1.5">{intl.formatMessage({ id: "web.routes.servers.running", defaultMessage: "Running", description: "Servers: 'Running' is both a summary card label counting running servers and a status filter tab that lists them with their count; keep it short" })}<span className="servers-status-filter__count rounded-[4px] bg-foreground/10 px-1.5 py-0.5 text-xs leading-none">
                    {counts.running}
                  </span>
                </span>
              </Tab>
              <Tab id="stopped">
                <span className="inline-flex items-center gap-1.5">{intl.formatMessage({ id: "web.routes.servers.stopped", defaultMessage: "Stopped", description: "Servers: status filter tab that shows only stopped servers, followed by their count; keep it short" })}<span className="servers-status-filter__count rounded-[4px] bg-foreground/10 px-1.5 py-0.5 text-xs leading-none">
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
                placeholder={intl.formatMessage({ id: "web.routes.servers.search_servers", defaultMessage: "Search servers…", description: "Servers: placeholder text inside the search box above the server list on wide screens, shown while the box is empty" })}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full pl-9"
                aria-label={intl.formatMessage({ id: "web.routes.servers.search_servers_2", defaultMessage: "Search servers", description: "Servers: screen-reader name of the server search box on wide and narrow screens; not shown on screen" })}
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
                <Filter className="h-4 w-4" />{intl.formatMessage({ id: "web.routes.servers.filter", defaultMessage: "Filter", description: "Servers: button that opens the filter panel, with a count of applied filters; keep it short" })}{appliedFacetCount > 0 && (
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
              placeholder={intl.formatMessage({ id: "web.routes.servers.search", defaultMessage: "Search…", description: "Servers: placeholder inside the search box shown on narrow screens; the short form of the search prompt" })}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-9 rounded-xl"
              aria-label={intl.formatMessage({ id: "web.routes.servers.search_servers_2", defaultMessage: "Search servers", description: "Servers: screen-reader name of the server search box on wide and narrow screens; not shown on screen" })}
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
              <span className="sr-only">{intl.formatMessage({ id: "web.routes.servers.filter", defaultMessage: "Filter", description: "Servers: button that opens the filter panel, with a count of applied filters; keep it short" })}</span>
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
            <Card className="p-10 text-center text-sm text-foreground/60">{intl.formatMessage({ id: "web.routes.servers.loading", defaultMessage: "Loading…", description: "Servers: text shown in a card while the server list is loading, in place of the list" })}</Card>
          )}
          {!isLoading && standalone.length === 0 && groups.length === 0 && (
            <Card className="p-12 text-center text-sm text-foreground/60">{error || fleet?.partial ? intl.formatMessage({ id: "web.routes.servers.no_data_for_filter", defaultMessage: "No server data available for this filter.", description: "Servers: empty-list message when server data is unavailable or partial" }) : intl.formatMessage({ id: "web.routes.servers.no_servers_match", defaultMessage: "No servers match.", description: "Servers: empty-list message when no servers match the filter" })}</Card>
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
          <div ref={setTableBox} className="rounded-lg border border-border bg-card overflow-hidden">
            <Table.Root className="bg-transparent">
              <Table.ScrollContainer>
                <Table.Content aria-label={intl.formatMessage({ id: "web.routes.servers.server_list", defaultMessage: "Server list", description: "Servers: hidden name of the server list table, read only by screen readers" })} keyboardNavigationBehavior="arrow" dragAndDropHooks={dragAndDropHooks}>
                  <Table.Header>
                    <Table.Column id="drag" className="w-10"><span className="sr-only">{intl.formatMessage({ id: "web.routes.servers.reorder", defaultMessage: "Reorder", description: "Servers: hidden column heading of the drag handle column used to reorder servers; read only by screen readers" })}</span></Table.Column>
                    <Table.Column id="name" isRowHeader>{intl.formatMessage({ id: "web.routes.servers.name", defaultMessage: "Name", description: "Servers: column heading for the server name; keep it short" })}</Table.Column>
                    <Table.Column id="game">{intl.formatMessage({ id: "web.routes.servers.game", defaultMessage: "Game", description: "Servers: column heading for the game each server runs; keep it short" })}</Table.Column>
                    <Table.Column id="status">{intl.formatMessage({ id: "web.routes.servers.status", defaultMessage: "Status", description: "Servers: column heading for the server state, such as running or stopped; keep it short" })}</Table.Column>
                    <Table.Column id="uptime">{intl.formatMessage({ id: "web.routes.servers.uptime", defaultMessage: "Uptime", description: "Servers: column heading for how long each server has been running; keep it short" })}</Table.Column>
                    <Table.Column id="cpu">{intl.formatMessage({ id: "web.routes.servers.cpu", defaultMessage: "CPU", description: "Servers: column heading for CPU use per server; CPU is a technical term, usually left untranslated; keep it short" })}</Table.Column>
                    <Table.Column id="memory">{intl.formatMessage({ id: "web.routes.servers.memory", defaultMessage: "Memory", description: "Servers: column heading for memory use per server; keep it short" })}</Table.Column>
                    <Table.Column id="disk">{intl.formatMessage({ id: "web.routes.servers.disk", defaultMessage: "Disk", description: "Servers: column heading for disk use per server; keep it short" })}</Table.Column>
                    <Table.Column id="players">{intl.formatMessage({ id: "web.routes.servers.players", defaultMessage: "Players", description: "Servers: column heading for the number of players online on each server; keep it short" })}</Table.Column>
                    <Table.Column id="node">{intl.formatMessage({ id: "web.routes.servers.node", defaultMessage: "Node", description: "Servers: column heading for the cluster node each server runs on; keep it short" })}</Table.Column>
                    <Table.Column id="actions" className="text-right">{intl.formatMessage({ id: "web.routes.servers.actions", defaultMessage: "Actions", description: "Servers: column heading for the row buttons such as start, stop and restart; keep it short" })}</Table.Column>
                  </Table.Header>
                  <Table.Body
                    renderEmptyState={() => (
                      <div className="text-center py-10 text-foreground/60">
                        {isLoading
                          ? intl.formatMessage({ id: "web.routes.servers.loading_servers", defaultMessage: "Loading…", description: "Servers: table empty state while servers load" })
                          : error || fleet?.partial
                            ? intl.formatMessage({ id: "web.routes.servers.no_data_for_filter", defaultMessage: "No server data available for this filter.", description: "Servers: empty-list message when server data is unavailable or partial" })
                            : intl.formatMessage({ id: "web.routes.servers.no_servers_match", defaultMessage: "No servers match.", description: "Servers: empty-list message when no servers match the filter" })}
                      </div>
                    )}
                  >
                {standalone.map((gs) => (
                  <Table.Row key={targetKey(resourceTarget(gs))} id={targetKey(resourceTarget(gs))} textValue={gs.metadata.name}>
                    <Table.Cell>
                      <Button slot="drag" isIconOnly variant="ghost" size="sm" aria-label={intl.formatMessage({ id: "web.routes.servers.reorder_server", defaultMessage: "Reorder {name}", description: "Servers: accessible label of the drag handle on a server row; {name} is the server name" }, { name: gs.metadata.name })} className="cursor-grab text-foreground/40 hover:text-foreground">
                        <GripVertical className="h-4 w-4" />
                      </Button>
                    </Table.Cell>
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
                        const { phase, asleep } = serverRowData(intl, gs);
                        return <PhaseChip phase={phase} asleep={asleep} />;
                      })()}
                    </Table.Cell>
                    <Table.Cell>
                      <span className="whitespace-nowrap font-mono">{serverRowData(intl, gs).uptimeLabel}</span>
                    </Table.Cell>
                    <Table.Cell>
                      {(() => {
                        const { cpuLabel } = serverRowData(intl, gs);
                        return <span className="font-mono">{cpuLabel}</span>;
                      })()}
                    </Table.Cell>
                    <Table.Cell>
                      {(() => {
                        const { memLabel } = serverRowData(intl, gs);
                        return <span className="whitespace-nowrap font-mono">{memLabel}</span>;
                      })()}
                    </Table.Cell>
                    <Table.Cell>
                      {(() => {
                        const { diskLabel } = serverRowData(intl, gs);
                        return <span className="whitespace-nowrap font-mono">{diskLabel}</span>;
                      })()}
                    </Table.Cell>
                    <Table.Cell>
                      {(() => {
                        const { playersLabel } = serverRowData(intl, gs);
                        return <span className="font-mono">{playersLabel}</span>;
                      })()}
                    </Table.Cell>
                    <Table.Cell>
                      {(() => {
                        const { node } = serverRowData(intl, gs);
                        return <span className="font-mono text-foreground/60">{node ?? emptyValue}</span>;
                      })()}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {(() => {
                        const { phase, asleep } = serverRowData(intl, gs);
                        return <ServerLifecycleActions gs={gs} phase={phase} asleep={asleep} pending={act.isPending} onAct={act.mutate} compact={fit.compact} />;
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
function serverRowData(intl: ReturnType<typeof useOptionalIntl>, gs: GameServer) {
  const emptyValue = intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" });
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
      : formatCpuPercent(cpuMilli / 1000)
    : emptyValue;

  const memLabel = usageLabel(agent?.memoryBytes, agent?.memoryLimitBytes);
  const diskLabel = usageLabel(agent?.diskUsedBytes, agent?.diskTotalBytes);
  const uptimeLabel = phase === "Running" ? formatUptime(gs.status?.startedAt, intl) : emptyValue;

  const playersLabel =
    typeof players === "number" && players >= 0
      ? typeof maxPlayers === "number" && maxPlayers >= 0
        ? intl.formatMessage({ id: "web.routes.servers.players_of_max", defaultMessage: "{players}/{max}", description: "Servers: player count as online/max; both are numbers" }, { players, max: maxPlayers })
        : `${players}`
      : emptyValue;

  return { phase, asleep, node, isSharedNonDefault, cpuLabel, memLabel, diskLabel, playersLabel, uptimeLabel };
}

function usageLabel(used?: number | null, max?: number | null): string {
  if (typeof used !== "number") return "—";
  return max ? `${formatBytes(used)} / ${formatBytes(max)}` : formatBytes(used);
}

// ServerLifecycleActions is the Start/Stop/Restart/menu cluster shared by
// the desktop table row and the mobile card.
function ServerLifecycleActions({
  gs,
  phase,
  asleep,
  onAct,
  pending,
  compact = 0,
}: {
  gs: Located<GameServer>;
  phase?: GameServerPhase;
  asleep?: boolean;
  pending: boolean;
  onAct: (args: { target: FleetTarget; verb: LifecycleVerb }) => void;
  compact?: number;
}) {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const running = phase === "Running" || phase === "Starting";
  const stopped = !asleep && (phase === "Stopped" || phase === "Suspended");
  const stopping = phase === "Stopping";
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["fleet", "servers"] });
  };
  return (
    <div className="inline-flex items-center">
      {asleep ? (
        <ActionButton
          title={intl.formatMessage({ id: "web.routes.servers.wake", defaultMessage: "Wake", description: "Servers: tooltip of the icon button that wakes a sleeping server; keep it short" })}
          disabled={pending || !gs.fleetAccess?.canControl}
          onClick={() => onAct({ target: gs.fleetTarget, verb: "wake" })}
        >
          <Sunrise className="h-4 w-4" />
        </ActionButton>
      ) : !(compact > 1 && running) && (
        <ActionButton
          title={intl.formatMessage({ id: "web.routes.servers.start", defaultMessage: "Start", description: "Servers: tooltip of the icon button that starts a stopped server; keep it short" })}
          disabled={pending || !gs.fleetAccess?.canControl || running}
          onClick={() => onAct({ target: gs.fleetTarget, verb: "start" })}
        >
          <Play className="h-4 w-4" />
        </ActionButton>
      )}
      {!(compact > 1 && stopped) && (
        <>
          <ActionButton
            title={stopping
              ? intl.formatMessage({ id: "web.routes.servers.kill", defaultMessage: "Kill", description: "Servers: tooltip of the icon button that force-kills a server that is still stopping; keep it short" })
              : intl.formatMessage({ id: "web.routes.servers.stop", defaultMessage: "Stop", description: "Servers: tooltip of the icon button that stops a running server; keep it short" })}
            // An asleep server is phase Suspended, but :stop is still a real
            // action there — it patches spec.suspend=true, which the operator
            // honors immediately, distinct from an idle sleep a wake window
            // would otherwise resurrect.
            disabled={pending || !gs.fleetAccess?.canControl || stopped}
            onClick={() => onAct({ target: gs.fleetTarget, verb: stopping ? "kill" : "stop" })}
          >
            {stopping ? <Skull className="h-4 w-4 text-danger" /> : <Square className="h-4 w-4" />}
          </ActionButton>
          <ActionButton
            title={intl.formatMessage({ id: "web.routes.servers.restart", defaultMessage: "Restart", description: "Servers: tooltip of the icon button that restarts a server; keep it short" })}
            disabled={pending || !gs.fleetAccess?.canControl}
            onClick={() => onAct({ target: gs.fleetTarget, verb: "restart" })}
          >
            <RotateCw className="h-4 w-4" />
          </ActionButton>
        </>
      )}
      {compact < 1 && <ServerActionsMenu gs={gs} target={gs.fleetTarget} access={gs.fleetAccess ? { ...gs.fleetAccess, permissions: gs.fleetPermissions } : undefined} onDeleted={invalidate} onTransferred={invalidate} size="sm" className="text-foreground/60 hover:text-foreground" />}
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
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const groupUnavailable = intl.formatMessage({ id: "web.routes.servers.group_unavailable", defaultMessage: "Group unavailable", description: "Servers: error shown in the banner on a server group card when its group data is missing and the change cannot be made" });
  const client = useMemo(() => createResourceClient({ cluster: group.cluster, namespace: group.namespace }), [group.cluster, group.namespace]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["fleet"] });
  const scale = useMutation({
    mutationFn: (replicas: number) => group.set ? client.ServerSets.scale(group.name, replicas) : Promise.reject(new Error(groupUnavailable)),
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
          aria-label={expanded
            ? intl.formatMessage({ id: "web.routes.servers.collapse_group", defaultMessage: "Collapse group {name}", description: "Servers: accessible name of the button on a server group card that collapses the card to hide its servers; {name} is the group name" }, { name: group.name })
            : intl.formatMessage({ id: "web.routes.servers.expand_group", defaultMessage: "Expand group {name}", description: "Servers: accessible name of the button on a server group card that expands the card to show its servers; {name} is the group name" }, { name: group.name })}
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
              <Chip size="sm" variant="soft"><Layers className="h-3 w-3" /> {intl.formatMessage({ id: "web.routes.servers.group", defaultMessage: "Group", description: "Servers: small chip on a server group card that marks the card as a group; keep it short" })}</Chip>
            </div>
            <div className="truncate text-xs text-muted">{targetLabel(group)} {intl.formatMessage({ id: "web.common.separator_dot", defaultMessage: "·", description: "Visual separator between two items" })} {game}</div>
          </div>
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <StatChip icon={<Activity className="h-3.5 w-3.5" />} value={intl.formatMessage({ id: "web.routes.servers.group_ready", defaultMessage: "{ready}/{desired} ready", description: "Servers: stat chip on a server group card with the number of ready servers out of the desired count; both are numbers" }, { ready, desired })} />
          <StatChip icon={<UsersIcon className="h-3.5 w-3.5" />} value={players} />
          <StatChip icon={<ServerIcon className="h-3.5 w-3.5" />} value={intl.formatMessage({ id: "web.routes.servers.group_nodes", defaultMessage: "{count, plural, one {# node} other {# nodes}}", description: "Servers: stat chip on a server group card with the number of nodes its servers run on; {count} is the node count" }, { count: nodes })} />
          {canWrite && (
            <div className="inline-flex items-center rounded-full border border-border">
              <ActionButton title={intl.formatMessage({ id: "web.routes.servers.remove_replica", defaultMessage: "Remove replica", description: "Servers: tooltip of the icon button on a server group card that removes one replica; keep it short" })} disabled={busy || desired <= 0} onClick={() => scale.mutate(desired - 1)}>
                <Minus className="h-4 w-4" />
              </ActionButton>
              <span className="min-w-6 text-center font-mono text-sm" aria-label={intl.formatMessage({ id: "web.routes.servers.replicas", defaultMessage: "Replicas", description: "Servers: accessible name of the replica count between the remove and add buttons on a server group card; read only by screen readers" })}>{desired}</span>
              <ActionButton title={intl.formatMessage({ id: "web.routes.servers.add_replica", defaultMessage: "Add replica", description: "Servers: tooltip of the plus button on a group card that adds one replica; keep it short" })} disabled={busy || desired >= 100} onClick={() => scale.mutate(desired + 1)}>
                <Plus className="h-4 w-4" />
              </ActionButton>
            </div>
          )}
          {canWrite && (
            <ActionButton title={intl.formatMessage({ id: "web.routes.servers.delete_group", defaultMessage: "Delete group", description: "Servers: tooltip of the trash icon button on a server group card that deletes the group, and the confirm button label in its delete dialog; keep it short" })} disabled={busy} onClick={() => setConfirmDelete(true)}>
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
          {shown.length === 0 && <div className="text-sm text-muted">{intl.formatMessage({ id: "web.routes.servers.no_replicas_running", defaultMessage: "No replicas running.", description: "Servers: text shown in an expanded server group card when it has no servers to list" })}</div>}
          {shown.map((gs) => {
            const { phase, asleep, node } = serverRowData(intl, gs);
            return (
              <ServerCard
                key={targetKey(resourceTarget(gs))}
                gs={gs}
                templates={templates}
                gameCodes={gameCodes}
                footer={
                  <div className="flex items-center justify-between gap-2">
                    <StatChip icon={<ServerIcon className="h-3.5 w-3.5" />} value={node ?? intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" })} />
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
        title={intl.formatMessage({ id: "web.routes.servers.delete_group_title", defaultMessage: "Delete group {name}?", description: "Servers: title of the dialog that asks before deleting a server group; {name} is the group name" }, { name: group.name })}
        description={intl.formatMessage({ id: "web.routes.servers.delete_group_description", defaultMessage: "This deletes the group and all {count} of its servers.", description: "Servers: body of the dialog that asks before deleting a server group; {count} is how many servers the group has" }, { count: desired })}
        confirmLabel={intl.formatMessage({ id: "web.routes.servers.delete_group", defaultMessage: "Delete group", description: "Servers: tooltip of the trash icon button on a server group card that deletes the group, and the confirm button label in its delete dialog; keep it short" })}
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
  const intl = useOptionalIntl();
  const { phase, asleep, memLabel, diskLabel, playersLabel, uptimeLabel } = serverRowData(intl, gs);

  // Extract address from the first endpoint, if available
  const endpoint = gs.status?.endpoints?.[0];
  const address = endpoint ? `${endpoint.host}:${endpoint.port}` : intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" });

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
              title={gs.metadata.name}
            >
              {gs.metadata.name}
            </Link>
            <div className="truncate text-xs text-muted" title={targetLabel(resourceTarget(gs))}>{targetLabel(resourceTarget(gs))}</div>
            <div className="truncate text-xs text-foreground/60 font-mono" title={address}>
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
        <StatChip icon={<HardDrive className="h-3.5 w-3.5" />} value={diskLabel} />
        <StatChip icon={<Clock className="h-3.5 w-3.5" />} value={uptimeLabel} />
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
