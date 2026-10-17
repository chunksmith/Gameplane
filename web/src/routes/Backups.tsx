import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { Archive, CalendarClock, CalendarPlus, CheckCircle2, History, Layers, Loader2, Plus, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { createResourceClient } from "@/lib/endpoints";
import { useFleetLocation, Fleet, located, targetKey, targetLabel, type Located } from "@/lib/fleet";
import { FleetCoverage } from "@/components/FleetScope";
import {
  Button,
  Card,
  Label,
  Select,
  ListBox,
  ListBoxItem,
  Tabs,
  Tab,
  Table,
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  ModalFooter,
  Switch,
} from "@heroui/react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatRelative, formatRelativeFuture } from "@/lib/utils";
import { cronPreset, describeCron } from "@/lib/backupGroups";
import { PhaseChip } from "@/components/ui/PhaseChip";
import { ErrorBanner } from "@/components/backups/ErrorBanner";
import { ScheduleForm } from "@/components/backups/ScheduleForm";
import { RestoreDialog } from "@/components/backups/RestoreDialog";
import { BackupDetailDrawer } from "@/components/backups/BackupDetailDrawer";
import { BackupRow } from "@/components/backups/BackupRow";
import { BackupFilters } from "@/components/backups/BackupFilters";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatCard } from "@/components/ui/StatCard";
import { ActiveBackups, isActiveBackup, newestBackupFirst } from "@/components/backups/ActiveBackups";
import { BackupGroupsPanel, groupMembers } from "@/components/backups/BackupGroupsPanel";
import type { Backup, BackupSchedule } from "@/types";
import { useOptionalIntl } from "@/lib/i18n/format";
import { defineMessages, type MessageDescriptor } from "react-intl";

type TabKey = "backups" | "groups" | "schedules" | "restores";
const TAB_LABELS = defineMessages({
  backups: { id: "web.routes.backups.tab_backups", defaultMessage: "Backups", description: "Backups: label of the backups tab" },
  groups: { id: "web.routes.backups.tab_groups", defaultMessage: "Groups", description: "Backups: label of the groups tab, where one schedule backs up several servers" },
  schedules: { id: "web.routes.backups.tab_server_schedules", defaultMessage: "Server schedules", description: "Backups: label of the server schedules tab, which lists the backup schedules of single servers" },
  restores: { id: "web.routes.backups.tab_restores", defaultMessage: "Restores", description: "Backups: label of the restores tab" },
});
const TABS: { id: TabKey; label: MessageDescriptor; icon: ReactNode }[] = [
  { id: "backups", label: TAB_LABELS.backups, icon: <Archive className="h-4 w-4" /> },
  { id: "groups", label: TAB_LABELS.groups, icon: <Layers className="h-4 w-4" /> },
  { id: "schedules", label: TAB_LABELS.schedules, icon: <CalendarClock className="h-4 w-4" /> },
  { id: "restores", label: TAB_LABELS.restores, icon: <History className="h-4 w-4" /> },
];

const SERVER_OPTION_LABEL: Record<string, MessageDescriptor> = defineMessages({
  label: { id: "web.routes.backups.server_option_label", defaultMessage: "{name} · {target}", description: "Backups: server picker option; {name} is the server name, {target} is its cluster and namespace" },
});

const TRAILING_COUNT: Record<"backups" | "schedules" | "restores", MessageDescriptor> = defineMessages({
  backups: { id: "web.routes.backups.trailing_backups", defaultMessage: "{shown} of {total} {total, plural, one {backup} other {backups}}", description: "Backups: count shown after the filters on the backups tab; {shown} is the number listed, {total} the number loaded" },
  schedules: { id: "web.routes.backups.trailing_schedules", defaultMessage: "{shown} of {total} {total, plural, one {schedule} other {schedules}}", description: "Backups: count shown after the filters on the schedules tab; {shown} is the number listed, {total} the number loaded" },
  restores: { id: "web.routes.backups.trailing_restores", defaultMessage: "{shown} of {total} {total, plural, one {restore} other {restores}}", description: "Backups: count shown after the filters on the restores tab; {shown} is the number listed, {total} the number loaded" },
});

const BACKUP_PHASES = ["Queued", "Pending", "Running", "Succeeded", "Failed"];
const DAY = 24 * 60 * 60 * 1000;
const RESTORE_PHASES = ["Pending", "Suspending", "Running", "Resuming", "Succeeded", "Failed"];
const TABLE_FRAME = "overflow-hidden rounded-lg border border-border bg-card";

export function BackupsPage() {
  const intl = useOptionalIntl();
  const search = useLocation().search;
  const navigate = useNavigate();
  const tab: TabKey = search.tab === "groups" || search.tab === "schedules" || search.tab === "restores" ? search.tab : "backups";
  const setTab = (next: TabKey) => {
    void navigate({ to: "/backups", replace: true, search: (previous) => ({ ...previous, tab: next === "backups" ? undefined : next }) });
  };
  const [backupNow, setBackupNow] = useState(false);
  const [location, setLocation] = useFleetLocation();
  const { data: serverScopes } = useQuery({ queryKey: ["fleet", "servers", "", ""], queryFn: ({ signal }) => Fleet.servers({}, signal) });
  const backupScopes = useQueries({ queries: (["backups", "schedules", "restores"] as const).map((kind) => ({
    queryKey: ["fleet", kind, ""], queryFn: ({ signal }: { signal: AbortSignal }) => Fleet[kind]({}, signal),
  })) });
  const locations = [...(serverScopes?.scopes ?? []).map((scope) => scope.cluster), ...(serverScopes?.items ?? []).map((item) => item.target.cluster), ...backupScopes.flatMap((query) => [...(query.data?.scopes ?? []).map((scope) => scope.cluster), ...(query.data?.items ?? []).map((item) => item.target.cluster)])];
  const [selected, setSelected] = useState<Located<Backup> | null>(null);
  const [restoring, setRestoring] = useState<Located<Backup> | null>(null);
  const { data: liveBackups, dataUpdatedAt } = useQuery({
    queryKey: ["fleet", "backups", ""],
    queryFn: ({ signal }) => Fleet.backups({}, signal),
    refetchInterval: 5000,
  });
  const allBackups = useMemo(() => (liveBackups?.items ?? []).map(located), [liveBackups]);
  const { data: liveSchedules } = useQuery({
    queryKey: ["fleet", "schedules", ""],
    queryFn: ({ signal }) => Fleet.schedules({}, signal),
    refetchInterval: 10000,
  });
  const allSchedules = useMemo(() => (liveSchedules?.items ?? []).map(located), [liveSchedules]);
  const allServers = useMemo(() => (serverScopes?.items ?? []).map(located), [serverScopes]);
  const active = allBackups.filter(isActiveBackup);
  const recent = allBackups.filter((b) => b.status?.completionTime && dataUpdatedAt - Date.parse(b.status.completionTime) < DAY);
  const groupSchedules = allSchedules.filter((s) => (s.spec.groups?.length ?? 0) > 0);
  const activeServerSchedules = allSchedules.filter((s) => !s.spec.suspend && !s.spec.groups?.length);
  const covered = new Set(groupSchedules.filter((s) => !s.spec.suspend).flatMap((s) => groupMembers(s, allServers).map((server) => targetKey(server.fleetTarget))));
  const coverageKnown = !!serverScopes && !!liveSchedules;
  const unprotected = !coverageKnown ? [] : allServers.filter((server) => !covered.has(targetKey(server.fleetTarget)) && !activeServerSchedules.some((s) => matchesServer(s, targetKey(server.fleetTarget), [server])));
  const activeSchedules = allSchedules.filter((s) => !s.spec.suspend).length;
  const nextRun = allSchedules
    .filter((s) => !s.spec.suspend && s.status?.nextScheduleTime)
    .sort((a, b) => Date.parse(a.status!.nextScheduleTime!) - Date.parse(b.status!.nextScheduleTime!))[0];
  const counts: Record<TabKey, number> = {
    backups: allBackups.length,
    groups: groupSchedules.length,
    schedules: allSchedules.length - groupSchedules.length,
    restores: (backupScopes[2].data?.items ?? []).length,
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={intl.formatMessage({ id: "web.routes.backups.backups", defaultMessage: "Backups", description: "Backups: page title at the top of the backups screen, also the name of the backups tab and its table; keep it short" })}
        subtitle={intl.formatMessage({ id: "web.routes.backups.snapshots_group_schedules_and_restores_across", defaultMessage: "Snapshots, group schedules, and restores across your authorized locations.", description: "Backups: subtitle under the page title saying the screen covers snapshots, group schedules and restores across the locations the user is authorized for" })}
        actions={
          <Button onPress={() => setBackupNow(true)}>
            <Plus className="h-4 w-4" /> {intl.formatMessage({ id: "web.routes.backups.back_up_now", defaultMessage: "Back up now", description: "Backups: button that opens the dialog for a one-off snapshot, and the heading of that dialog; keep it short" })}</Button>
        }
      />
      {backupNow && <BackupNowDialog onClose={() => setBackupNow(false)} />}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={intl.formatMessage({ id: "web.routes.backups.stat_running", defaultMessage: "Running", description: "Backups: stat card label for how many backups are running right now; keep it short" })}
          value={active.filter((b) => b.status?.phase === "Running").length}
          sub={intl.formatMessage({ id: "web.routes.backups.stat_queued", defaultMessage: "{count} queued", description: "Backups: stat card detail under the Running count giving how many backups are waiting in the queue; {count} is a number" }, { count: active.filter((b) => b.status?.phase === "Queued").length })}
          icon={<Loader2 className={active.some((b) => b.status?.phase === "Running") ? "animate-spin" : ""} />}
        />
        <StatCard
          label={intl.formatMessage({ id: "web.routes.backups.stat_last_24h", defaultMessage: "Last 24h", description: "Backups: stat card label for how many backups succeeded in the last 24 hours; keep it short" })}
          value={recent.filter((b) => b.status?.phase === "Succeeded").length}
          sub={intl.formatMessage({ id: "web.routes.backups.stat_failed", defaultMessage: "{count} failed", description: "Backups: stat card detail under the Last 24h count giving how many backups failed in the last 24 hours; {count} is a number" }, { count: recent.filter((b) => b.status?.phase === "Failed").length })}
          icon={<CheckCircle2 />}
          accent={recent.some((b) => b.status?.phase === "Failed") ? "danger" : "success"}
        />
        <StatCard
          label={intl.formatMessage({ id: "web.routes.backups.stat_protected", defaultMessage: "Protected", description: "Backups: stat card label for how many servers have automatic backups; the value shows covered servers out of all servers" })}
          value={coverageKnown ? `${allServers.length - unprotected.length}/${allServers.length}` : intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" })}
          sub={intl.formatMessage({ id: "web.routes.backups.stat_active_schedules", defaultMessage: "{count, plural, one {{count} active schedule} other {{count} active schedules}}", description: "Backups: stat card detail under the Protected count giving how many schedules are active; {count} is a number" }, { count: activeSchedules })}
          icon={unprotected.length > 0 ? <ShieldAlert /> : <ShieldCheck />}
          accent={unprotected.length > 0 ? "warning" : "success"}
        />
        <StatCard
          label={intl.formatMessage({ id: "web.routes.backups.next_run", defaultMessage: "Next run", description: "Backups: column heading for when a schedule runs next; keep it short" })}
          value={nextRun ? formatRelativeFuture(nextRun.status?.nextScheduleTime, intl) : intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" })}
          sub={nextRun?.metadata.name ?? intl.formatMessage({ id: "web.routes.backups.no_active_schedules", defaultMessage: "No active schedules", description: "Backups: stat card detail under Next run when no schedule is active" })}
          icon={<CalendarClock />}
        />
      </div>
      {unprotected.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 sm:flex-row sm:items-center">
          <ShieldAlert className="h-5 w-5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-warning-soft-foreground">
              {intl.formatMessage({ id: "web.routes.backups.unprotected_servers", defaultMessage: "{count, plural, one {{count} server has} other {{count} servers have}} no automatic backups", description: "Backups: warning above the list saying how many servers have no automatic backups; {count} is a number" }, { count: unprotected.length })}
            </div>
            <div className="truncate text-xs text-muted">{unprotected.map((server) => server.metadata.name).join(", ")}</div>
          </div>
          {tab !== "groups" && (
            <Button size="sm" variant="outline" onPress={() => setTab("groups")}>
              {intl.formatMessage({ id: "web.routes.backups.set_up_a_group_schedule", defaultMessage: "Set up a group schedule", description: "Backups: button in the warning about unprotected servers that opens the groups tab to set up a group schedule; keep it short" })}
            </Button>
          )}
        </div>
      )}
      <ActiveBackups backups={active} onSelect={setSelected} />
      <BackupDetailDrawer
        name={selected?.metadata.name ?? null}
        target={selected?.fleetTarget}
        permissions={selected?.fleetPermissions}
        onClose={() => setSelected(null)}
        onRestore={(b) => {
          if (selected) setRestoring({ ...b, fleetTarget: selected.fleetTarget, fleetPermissions: selected.fleetPermissions });
          setSelected(null);
        }}
      />
      <RestoreDialog backup={restoring} target={restoring?.fleetTarget} permissions={restoring?.fleetPermissions} onClose={() => setRestoring(null)} />
      <div className="-mx-1 flex overflow-x-auto px-1">
        <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(key as TabKey)} variant="secondary">
          <Tabs.List aria-label={intl.formatMessage({ id: "web.routes.backups.backup_sections", defaultMessage: "Backup sections", description: "Backups: accessible name of the row of section tabs; not visible on screen" })} className="servers-status-filter">
            {TABS.map((t) => (
              <Tab key={t.id} id={t.id}>
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  {t.icon}
                  {intl.formatMessage(t.label)}
                  <span aria-hidden="true" className="servers-status-filter__count rounded-[4px] bg-foreground/10 px-1.5 py-0.5 text-xs leading-none">
                    {counts[t.id]}
                  </span>
                </span>
              </Tab>
            ))}
          </Tabs.List>
        </Tabs>
      </div>
      {tab === "backups" && <BackupsTabPanel location={location} onLocationChange={setLocation} locations={locations} />}
      {tab === "groups" && <BackupGroupsPanel schedules={allSchedules} servers={allServers} />}
      {tab === "schedules" && <SchedulesTabPanel location={location} onLocationChange={setLocation} locations={locations} onOpenGroups={() => setTab("groups")} />}
      {tab === "restores" && <RestoresTabPanel location={location} onLocationChange={setLocation} locations={locations} />}
    </div>
  );
}

type LocationFilterProps = { location: string; onLocationChange: (location: string) => void; locations: string[] };

function BackupsTabPanel({ location, onLocationChange, locations }: LocationFilterProps) {
  const intl = useOptionalIntl();
  const [search, setSearch] = useState("");
  const [server, setServer] = useState("");
  const [phase, setPhase] = useState("");
  const [restoringBackup, setRestoringBackup] = useState<Located<Backup> | null>(null);
  const [selectedBackup, setSelectedBackup] = useState<Located<Backup> | null>(null);

  const { data: backupsFleet, error: fleetError, isLoading: fleetLoading } = useQuery({
    queryKey: ["fleet", "backups", location],
    queryFn: ({ signal }) => Fleet.backups({ cluster: location || undefined }, signal),
    refetchInterval: 5000,
  });
  const backups = useMemo(() => ({ items: (backupsFleet?.items ?? []).map(located) }), [backupsFleet]);
  const { data: serversFleet } = useQuery({
    queryKey: ["fleet", "servers", "", ""],
    queryFn: ({ signal }) => Fleet.servers({}, signal),
  });
  const serversList = { items: (serversFleet?.items ?? []).map(located) };

  const items = useMemo(() => backups?.items ?? [], [backups]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((b) => {
      if (server && !matchesServer(b, server, serversList.items)) return false;
      if (phase && b.status?.phase !== phase) return false;
      if (q) {
        const hay = `${b.metadata.name} ${b.spec.serverRef.name}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort(newestBackupFirst);
  }, [items, search, server, phase, serversList.items]);

  return (
    <div className="space-y-4">
      <FleetCoverage partial={backupsFleet?.partial} issues={backupsFleet?.issues} error={fleetError} label={intl.formatMessage({ id: "web.routes.backups.backups", defaultMessage: "Backups", description: "Backups: page title at the top of the backups screen, also the name of the backups tab and its table; keep it short" })} />
      {fleetLoading && <p className="text-sm text-muted">{intl.formatMessage({ id: "web.routes.backups.loading_backups", defaultMessage: "Loading backups…", description: "Backups: loading text on the backups tab while backup data is fetched" })}</p>}
      <BackupFilters
        location={location}
        onLocationChange={onLocationChange}
        locations={locations}
        search={search}
        onSearchChange={setSearch}
        server={server}
        onServerChange={setServer}
        phase={phase}
        onPhaseChange={setPhase}
        servers={serversList?.items ?? []}
        phases={BACKUP_PHASES}
        trailing={intl.formatMessage(TRAILING_COUNT.backups, { shown: filtered.length, total: items.length })}
      />

      <div className={TABLE_FRAME}>
        <Table.Root className="bg-transparent">
          <Table.ScrollContainer>
            <Table.Content aria-label={intl.formatMessage({ id: "web.routes.backups.backups", defaultMessage: "Backups", description: "Backups: page title at the top of the backups screen, also the name of the backups tab and its table; keep it short" })} keyboardNavigationBehavior="arrow">
              <Table.Header>
                <Table.Column key="name" isRowHeader>
                  {intl.formatMessage({ id: "web.routes.backups.backup", defaultMessage: "Backup", description: "Backups: column heading for the backup a restore came from; keep it short" })}
                </Table.Column>
                <Table.Column key="server">{intl.formatMessage({ id: "web.routes.backups.server", defaultMessage: "Server", description: "Backups: column heading for the server a row belongs to, and the accessible name of the server dropdown in the backup dialog; keep it short" })}</Table.Column>
                <Table.Column key="phase">{intl.formatMessage({ id: "web.routes.backups.status", defaultMessage: "Status", description: "Backups: column heading for the status of each backup or restore; keep it short" })}</Table.Column>
                <Table.Column key="progress">{intl.formatMessage({ id: "web.routes.backups.progress", defaultMessage: "Progress", description: "Backups: column heading for the live progress bar of each running backup; keep it short" })}</Table.Column>
                <Table.Column key="size">{intl.formatMessage({ id: "web.routes.backups.size", defaultMessage: "Size", description: "Backups: column heading for the size of each backup; keep it short" })}</Table.Column>
                <Table.Column key="added">{intl.formatMessage({ id: "web.routes.backups.added", defaultMessage: "Added", description: "Backups: column heading for how much new data each backup added; keep it short" })}</Table.Column>
                <Table.Column key="completed">{intl.formatMessage({ id: "web.routes.backups.completed", defaultMessage: "Completed", description: "Backups: column heading for when a backup or restore completed; keep it short" })}</Table.Column>
                <Table.Column key="actions" className="text-end" />
              </Table.Header>
              <Table.Body
                renderEmptyState={() =>
                  items.length > 0 ? (
                    <EmptyState icon={<Archive />} title={intl.formatMessage({ id: "web.routes.backups.no_backups_match_the_current_filters", defaultMessage: "No backups match the current filters.", description: "Backups: empty state when filters hide every backup" })} hint={intl.formatMessage({ id: "web.routes.backups.clear_the_search_or_filters", defaultMessage: "Clear the search or filters to see every snapshot.", description: "Backups: hint under the empty state when filters hide every backup, asking the user to clear the search or filters" })} />
                  ) : backupsFleet?.partial || fleetError ? (
                    <EmptyState icon={<Archive />} title={intl.formatMessage({ id: "web.routes.backups.no_backup_data_available", defaultMessage: "No backup data available.", description: "Backups: empty state when the backup list could not be loaded" })} />
                  ) : (
                    <EmptyState icon={<Archive />} title={intl.formatMessage({ id: "web.routes.backups.no_backups_yet_title", defaultMessage: "No backups yet.", description: "Backups: empty state title when no backups exist" })} hint={intl.formatMessage({ id: "web.routes.backups.use_back_up_now_to_take_the_first", defaultMessage: "Use \"Back up now\" to take the first snapshot, or add a schedule so it happens automatically.", description: "Backups: hint under the empty state when no backups exist; quoted text is the Back up now button label" })} />
                  )
                }
              >
                {filtered.map((b) => (
                  <BackupRow
                    key={targetKey(b.fleetTarget)}
                    target={b.fleetTarget}
                    permissions={b.fleetPermissions}
                    backup={b}
                    showServer
                    onSelect={() => setSelectedBackup(b)}
                    onRestore={() => setRestoringBackup(b)}
                  />
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table.Root>
      </div>

      <RestoreDialog
        backup={restoringBackup}
        target={restoringBackup?.fleetTarget}
        permissions={restoringBackup?.fleetPermissions}
        onClose={() => setRestoringBackup(null)}
      />
      <BackupDetailDrawer
        name={selectedBackup?.metadata.name ?? null}
        target={selectedBackup?.fleetTarget}
        permissions={selectedBackup?.fleetPermissions}
        onClose={() => setSelectedBackup(null)}
        onRestore={(b) => {
          if (selectedBackup) setRestoringBackup({ ...b, fleetTarget: selectedBackup.fleetTarget, fleetPermissions: selectedBackup.fleetPermissions });
          setSelectedBackup(null);
        }}
      />
    </div>
  );
}

// The "Back up now" form, relocated from an inline card above the table to a
// dialog launched from the page header. The query and mutation logic is unchanged;
// the dialog closes once the snapshot starts.
function BackupNowDialog({ onClose }: { onClose: () => void }) {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const [createServer, setCreateServer] = useState("");
  const [createDest, setCreateDest] = useState("");

  const { data: serversFleet } = useQuery({
    queryKey: ["fleet", "servers", "", ""],
    queryFn: ({ signal }) => Fleet.servers({}, signal),
  });
  const serversList = { items: (serversFleet?.items ?? []).map(located) };
  const selectedServer = serversList.items.find((item) => targetKey(item.fleetTarget) === createServer);
  const { data: destinationData } = useQuery({
    queryKey: ["backup-destinations", selectedServer?.fleetTarget.cluster, selectedServer?.fleetTarget.namespace],
    queryFn: () => createResourceClient(selectedServer!.fleetTarget).BackupDestinations.list(),
    enabled: !!selectedServer,
  });
  const destinations = destinationData?.items ?? [];

  // When destinations resolve, default to the first one. The user can
  // still pick a different one if more than one exists. Adjusted directly
  // during render (not in an effect) — the condition becomes false as soon
  // as createDest is set, so this can't loop.
  if (!createDest && destinations.length > 0) {
    setCreateDest(destinations[0].name);
  }

  const createNow = useMutation({
    mutationFn: () => {
      if (!selectedServer || !hasPermission(selectedServer.fleetPermissions, "backups:write")) throw new Error(intl.formatMessage({ id: "web.routes.backups.select_server_with_backup_access", defaultMessage: "Select a server with backup access.", description: "Backups: error shown when the chosen server has no backup permission" }));
      return createResourceClient(selectedServer.fleetTarget).Backups.create({
        serverRef: { name: selectedServer.metadata.name },
        repoRef: { name: createDest, key: "repo" },
      }, selectedServer.fleetTarget.namespace);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["fleet", "backups"] });
      onClose();
    },
  });

  const noDestinations = destinations.length === 0;

  return (
    <Modal isOpen onOpenChange={(open) => { if (!open) onClose(); }}>
      <ModalBackdrop isDismissable={!createNow.isPending} isKeyboardDismissDisabled={createNow.isPending}>
        <ModalContainer>
          <ModalDialog className="max-w-md">
            <ModalHeader>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
                <Archive className="h-5 w-5" />
              </span>
              <div className="space-y-1">
                <ModalHeading>{intl.formatMessage({ id: "web.routes.backups.back_up_now", defaultMessage: "Back up now", description: "Backups: button that opens the dialog for a one-off snapshot, and the heading of that dialog; keep it short" })}</ModalHeading>
                <p className="text-sm text-muted">{intl.formatMessage({ id: "web.routes.backups.run_a_one_off_snapshot_outside_any", defaultMessage: "Run a one-off snapshot outside any schedule.", description: "Backups: text in the back-up-now dialog explaining that it runs a one-off snapshot outside any schedule" })}</p>
              </div>
            </ModalHeader>
            <ModalBody className="gap-4">
              <Select
                value={createServer}
                onChange={(v) => { setCreateServer(v as string); setCreateDest(""); }}
                placeholder={intl.formatMessage({ id: "web.routes.backups.select_a_server", defaultMessage: "Select a server…", description: "Backups: grey placeholder of the server dropdown, asking the user to pick a server in the backup dialog or the new schedule form" })}
                className="space-y-1.5"
              >
                <Label className="text-xs">{intl.formatMessage({ id: "web.routes.backups.server", defaultMessage: "Server", description: "Backups: column heading for the server a row belongs to, and the accessible name of the server dropdown in the backup dialog; keep it short" })}</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator className="ml-auto h-4 w-4" />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox aria-label={intl.formatMessage({ id: "web.routes.backups.server_options", defaultMessage: "Server options", description: "Backups: accessible name of the list of servers shown when the server dropdown is open" })}>
                    {(serversList?.items ?? []).filter((item) => hasPermission(item.fleetPermissions, "backups:write")).map((s) => (
                      <ListBoxItem key={targetKey(s.fleetTarget)} id={targetKey(s.fleetTarget)} textValue={intl.formatMessage(SERVER_OPTION_LABEL.label, { name: s.metadata.name, target: targetLabel(s.fleetTarget) })}>
                        {intl.formatMessage(SERVER_OPTION_LABEL.label, { name: s.metadata.name, target: targetLabel(s.fleetTarget) })}
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              {destinations.length > 1 && (
                <Select
                  value={createDest}
                  onChange={(v) => setCreateDest(v as string)}
                  placeholder={intl.formatMessage({ id: "web.routes.backups.select_a_destination", defaultMessage: "Select a destination…", description: "Backups: grey placeholder of the destination dropdown in the back-up-now dialog, asking the user to pick a backup destination" })}
                  className="space-y-1.5"
                >
                  <Label className="text-xs">{intl.formatMessage({ id: "web.routes.backups.destination", defaultMessage: "Destination", description: "Backups: accessible name of the backup destination dropdown in the back-up-now dialog" })}</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator className="ml-auto h-4 w-4" />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox aria-label={intl.formatMessage({ id: "web.routes.backups.destination_options", defaultMessage: "Destination options", description: "Backups: accessible name of the list of backup destinations shown when the destination dropdown is open" })}>
                      {destinations.map((d) => (
                        <ListBoxItem key={d.name} id={d.name} textValue={d.name}>{d.name}</ListBoxItem>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              )}
              {noDestinations && (
                <p className="rounded-lg bg-default/40 px-3 py-2 text-xs text-muted">
                  {intl.formatMessage({ id: "web.routes.backups.no_backup_destinations_configured_add", defaultMessage: "No backup destinations configured. Add one in", description: "Backups: opening words of the note in the back-up-now dialog shown when no destination exists; the link and closing words follow it" })} <Link to="/admin" className="text-primary hover:underline">
                    {intl.formatMessage({ id: "web.routes.backups.admin_settings", defaultMessage: "admin settings", description: "Backups: link text inside the no-destination note that opens the admin settings screen; keep it short" })}
                  </Link> {intl.formatMessage({ id: "web.routes.backups.to_enable_snapshots", defaultMessage: "to enable snapshots.", description: "Backups: closing words of the no-destination note after the admin settings link, ending the sentence about enabling snapshots" })}
                </p>
              )}
              {createNow.error && <ErrorBanner err={createNow.error} />}
            </ModalBody>
            <ModalFooter>
              <Button variant="ghost" onPress={onClose} isDisabled={createNow.isPending}>{intl.formatMessage({ id: "web.routes.backups.cancel", defaultMessage: "Cancel", description: "Backups: button that closes the back-up-now dialog without starting a snapshot; keep it short" })}</Button>
              <Button
                variant="primary"
                isDisabled={!selectedServer || !createDest || createNow.isPending || noDestinations}
                onPress={() => createNow.mutate()}
              >
                {createNow.isPending
                  ? intl.formatMessage({ id: "web.routes.backups.starting", defaultMessage: "Starting…", description: "Backups: label of the Run snapshot button while the request is in flight" })
                  : intl.formatMessage({ id: "web.routes.backups.run_snapshot", defaultMessage: "Run snapshot", description: "Backups: label of the button that starts a snapshot now" })}
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}

function SchedulesTabPanel({ location, onLocationChange, locations, onOpenGroups }: LocationFilterProps & { onOpenGroups: () => void }) {
  const intl = useOptionalIntl();
  const [search, setSearch] = useState("");
  const [server, setServer] = useState("");
  const qc = useQueryClient();
  const [creatingFor, setCreatingFor] = useState<string>("");
  const [deleting, setDeleting] = useState<Located<BackupSchedule> | null>(null);

  const { data: schedulesFleet, error: fleetError, isLoading: fleetLoading } = useQuery({
    queryKey: ["fleet", "schedules", location],
    queryFn: ({ signal }) => Fleet.schedules({ cluster: location || undefined }, signal),
    refetchInterval: 10000,
  });
  const schedules = useMemo(() => ({ items: (schedulesFleet?.items ?? []).map(located) }), [schedulesFleet]);
  const { data: serversFleet } = useQuery({
    queryKey: ["fleet", "servers", "", ""],
    queryFn: ({ signal }) => Fleet.servers({}, signal),
  });
  const serversList = { items: (serversFleet?.items ?? []).map(located) };

  const items = (schedules?.items ?? []).filter((item) => !item.spec.groups?.length);
  const filtered = items.filter((item) => {
    if (server && !matchesServer(item, server, serversList.items)) return false;
    const q = search.trim().toLowerCase();
    return !q || `${item.metadata.name} ${item.spec.serverRef?.name ?? ""}`.toLowerCase().includes(q);
  });
  const selectedServer = serversList.items.find((item) => targetKey(item.fleetTarget) === creatingFor);

  const toggleSuspend = useMutation({
    mutationFn: ({ item, suspend }: { item: Located<BackupSchedule>; suspend: boolean }) =>
      createResourceClient(item.fleetTarget).Schedules.patchSpec(item.metadata.name, { suspend }, item.fleetTarget.namespace),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fleet", "schedules"] }),
  });

  const remove = useMutation({
    mutationFn: (item: Located<BackupSchedule>) => createResourceClient(item.fleetTarget).Schedules.remove(item.metadata.name, item.fleetTarget.namespace),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["fleet", "schedules"] });
      setDeleting(null);
    },
  });

  return (
    <div className="space-y-4">
      <FleetCoverage partial={schedulesFleet?.partial} issues={schedulesFleet?.issues} error={fleetError} label={intl.formatMessage({ id: "web.routes.backups.schedules", defaultMessage: "Schedules", description: "Backups: name of the schedules tab, also its table label and the title of its panel; keep it short" })} />
      {fleetLoading && <p className="text-sm text-muted">{intl.formatMessage({ id: "web.routes.backups.loading_schedules", defaultMessage: "Loading schedules…", description: "Backups: loading text on the schedules tab while schedule data is fetched" })}</p>}
      <Card className="flex flex-col gap-3 border border-dashed border-border bg-transparent p-4 sm:flex-row sm:items-center">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <CalendarPlus className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{intl.formatMessage({ id: "web.routes.backups.add_a_server_schedule", defaultMessage: "Add a server schedule", description: "Backups: heading of the card at the top of the schedules tab for adding a schedule to one server; keep it short" })}</div>
          <p className="text-xs text-muted">
            {intl.formatMessage({ id: "web.routes.backups.back_up_a_single_server_on_its_own_cron", defaultMessage: "Back up a single server on its own cron. Covering many servers? A", description: "Backups: first part of the hint in the add-schedule card, explaining that a single server gets its own cron; the group schedule link follows it" })} <button type="button" onClick={onOpenGroups} className="text-accent hover:underline">{intl.formatMessage({ id: "web.routes.backups.group_schedule", defaultMessage: "group schedule", description: "Backups: link text in the add-schedule card hint that opens the groups tab; keep it short" })}</button> {intl.formatMessage({ id: "web.routes.backups.is_easier_to_manage", defaultMessage: "is easier to manage.", description: "Backups: closing words of the add-schedule card hint, saying a group schedule is easier to manage" })}
          </p>
        </div>
        <Select
          value={creatingFor}
          onChange={(v) => setCreatingFor(v as string)}
          placeholder={intl.formatMessage({ id: "web.routes.backups.select_a_server", defaultMessage: "Select a server…", description: "Backups: grey placeholder of the server dropdown, asking the user to pick a server in the backup dialog or the new schedule form" })}
          className="w-full space-y-1.5 sm:w-72"
        >
          <Label className="text-xs text-muted">{intl.formatMessage({ id: "web.routes.backups.new_schedule_for", defaultMessage: "New schedule for", description: "Backups: label above the server dropdown of the new schedule form" })}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator className="ml-auto h-4 w-4" />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label={intl.formatMessage({ id: "web.routes.backups.server_options", defaultMessage: "Server options", description: "Backups: accessible name of the list of servers shown when the server dropdown is open" })}>
              {(serversList?.items ?? []).filter((item) => hasPermission(item.fleetPermissions, "schedules:write")).map((s) => (
                <ListBoxItem key={targetKey(s.fleetTarget)} id={targetKey(s.fleetTarget)} textValue={intl.formatMessage(SERVER_OPTION_LABEL.label, { name: s.metadata.name, target: targetLabel(s.fleetTarget) })}>
                  {intl.formatMessage(SERVER_OPTION_LABEL.label, { name: s.metadata.name, target: targetLabel(s.fleetTarget) })}
                </ListBoxItem>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </Card>

      {selectedServer && (
        <ScheduleForm target={selectedServer.fleetTarget} permissions={selectedServer.fleetPermissions} serverName={selectedServer.metadata.name} onClose={() => setCreatingFor("")} />
      )}
      {toggleSuspend.error && <ErrorBanner err={toggleSuspend.error} />}
      {remove.error && <ErrorBanner err={remove.error} />}

      <BackupFilters
        location={location}
        onLocationChange={onLocationChange}
        locations={locations}
        search={search}
        onSearchChange={setSearch}
        server={server}
        onServerChange={setServer}
        servers={serversList.items}
        trailing={intl.formatMessage(TRAILING_COUNT.schedules, { shown: filtered.length, total: items.length })}
      />

      <div className={TABLE_FRAME}>
        <Table.Root className="bg-transparent">
          <Table.ScrollContainer>
            <Table.Content aria-label={intl.formatMessage({ id: "web.routes.backups.schedules", defaultMessage: "Schedules", description: "Backups: name of the schedules tab, also its table label and the title of its panel; keep it short" })} keyboardNavigationBehavior="arrow">
              <Table.Header>
                <Table.Column key="name" isRowHeader>
                  {intl.formatMessage({ id: "web.routes.backups.name", defaultMessage: "Name", description: "Backups: column heading for the name of each backup, schedule or restore; keep it short" })}
                </Table.Column>
                <Table.Column key="server">{intl.formatMessage({ id: "web.routes.backups.server", defaultMessage: "Server", description: "Backups: column heading for the server a row belongs to, and the accessible name of the server dropdown in the backup dialog; keep it short" })}</Table.Column>
                <Table.Column key="cron">{intl.formatMessage({ id: "web.routes.backups.runs", defaultMessage: "Runs", description: "Backups: column heading for how often a schedule runs, shown as a plain-language cron description; keep it short" })}</Table.Column>
                <Table.Column key="lastrun">{intl.formatMessage({ id: "web.routes.backups.last_run", defaultMessage: "Last run", description: "Backups: column heading for when a schedule last ran; keep it short" })}</Table.Column>
                <Table.Column key="nextrun">{intl.formatMessage({ id: "web.routes.backups.next_run", defaultMessage: "Next run", description: "Backups: column heading for when a schedule runs next; keep it short" })}</Table.Column>
                <Table.Column key="active">{intl.formatMessage({ id: "web.routes.backups.active", defaultMessage: "Active", description: "Backups: column heading for the switch that turns a schedule on or off; keep it short" })}</Table.Column>
                <Table.Column key="actions" className="text-end" />
              </Table.Header>
              <Table.Body
                renderEmptyState={() =>
                  items.length > 0 ? (
                    <EmptyState icon={<CalendarClock />} title={intl.formatMessage({ id: "web.routes.backups.no_schedules_match_the_current_filters", defaultMessage: "No schedules match the current filters.", description: "Backups: schedules empty state when filters hide every schedule" })} />
                  ) : schedulesFleet?.partial || fleetError ? (
                    <EmptyState icon={<CalendarClock />} title={intl.formatMessage({ id: "web.routes.backups.no_schedule_data_available", defaultMessage: "No schedule data available.", description: "Backups: schedules empty state when the list could not be loaded" })} />
                  ) : (
                    <EmptyState icon={<CalendarClock />} title={intl.formatMessage({ id: "web.routes.backups.no_schedules_configured_yet", defaultMessage: "No schedules configured yet.", description: "Backups: schedules empty state when none exist" })} hint={intl.formatMessage({ id: "web.routes.backups.pick_a_server_above_to_add", defaultMessage: "Pick a server above to add its first per-server schedule.", description: "Backups: hint under the empty schedules state pointing to the server picker above" })} />
                  )
                }
              >
                {filtered.map((s) => (
                  <Table.Row key={targetKey(s.fleetTarget)}>
                    <Table.Cell>
                      <span className="font-mono text-xs">{s.metadata.name}</span><div className="text-xs text-muted">{targetLabel(s.fleetTarget)}</div>
                    </Table.Cell>
                    <Table.Cell className="font-medium">{s.spec.serverRef?.name}</Table.Cell>
                    <Table.Cell>
                      <div className="text-sm">{describeCron(s.spec.schedule, intl)}</div>
                      {cronPreset(s.spec.schedule) && <div className="font-mono text-xs text-muted">{s.spec.schedule}</div>}
                    </Table.Cell>
                    <Table.Cell className="text-foreground/60">
                      {formatRelative(s.status?.lastSuccessfulTime, intl)}
                    </Table.Cell>
                    <Table.Cell className="text-foreground/60">
                      {s.spec.suspend ? intl.formatMessage({ id: "web.routes.backups.paused", defaultMessage: "Paused", description: "Backups: next-run cell of a schedule that is paused, shown instead of a time; keep it short" }) : formatRelativeFuture(s.status?.nextScheduleTime, intl)}
                    </Table.Cell>
                    <Table.Cell>
                      <Switch
                        isSelected={!s.spec.suspend}
                        isDisabled={!hasPermission(s.fleetPermissions, "schedules:write") || toggleSuspend.isPending}
                        onChange={(isSelected) =>
                          toggleSuspend.mutate({ item: s, suspend: !isSelected })
                        }
                        aria-label={intl.formatMessage({ id: "web.routes.backups.schedule_active", defaultMessage: "Schedule active", description: "Backups: accessible name of the switch that turns a schedule on or off" })}
                      >
                        <Switch.Content>
                          <Switch.Control>
                            <Switch.Thumb />
                          </Switch.Control>
                        </Switch.Content>
                      </Switch>
                    </Table.Cell>
                    <Table.Cell className="text-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger"
                        isDisabled={!hasPermission(s.fleetPermissions, "schedules:write")}
                        onPress={() => setDeleting(s)}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> {intl.formatMessage({ id: "web.routes.backups.delete", defaultMessage: "Delete", description: "Backups: button that starts deleting a schedule row, and the confirm button of the delete schedule dialog; keep it short" })}
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table.Root>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title={intl.formatMessage({ id: "web.routes.backups.delete_schedule", defaultMessage: "Delete schedule?", description: "Backups: title of the dialog asking whether to delete a schedule" })}
        description={
          <>
            <p>{intl.formatMessage({ id: "web.routes.backups.the_cron_schedule_will_be_removed", defaultMessage: "The cron schedule will be removed. Existing backups remain intact; new snapshots on this schedule will stop running until it's recreated.", description: "Backups: text in the delete schedule dialog: the schedule is removed, existing backups stay, and new snapshots stop until it is recreated" })}</p>
            {deleting && (
              <p className="pt-2">{intl.formatMessage({ id: "web.routes.backups.type_name_to_confirm", defaultMessage: "Type {name} ({target}) to confirm.", description: "Backups: confirmation hint under the delete-schedule dialog; {name} is the schedule name in monospace, {target} is its cluster and namespace" }, { name: <span className="font-mono">{deleting.metadata.name}</span>, target: targetLabel(deleting.fleetTarget) })}</p>
            )}
          </>
        }
        confirmPhrase={deleting?.metadata.name}
        confirmLabel={intl.formatMessage({ id: "web.routes.backups.delete", defaultMessage: "Delete", description: "Backups: button that starts deleting a schedule row, and the confirm button of the delete schedule dialog; keep it short" })}
        destructive
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

function RestoresTabPanel({ location, onLocationChange, locations }: LocationFilterProps) {
  const intl = useOptionalIntl();
  const [server, setServer] = useState("");
  const [phase, setPhase] = useState("");
  const [search, setSearch] = useState("");

  const { data: restoresFleet, error: fleetError, isLoading: fleetLoading } = useQuery({
    queryKey: ["fleet", "restores", location],
    queryFn: ({ signal }) => Fleet.restores({ cluster: location || undefined }, signal),
    refetchInterval: 5000,
  });
  const restores = useMemo(() => ({ items: (restoresFleet?.items ?? []).map(located) }), [restoresFleet]);
  const { data: serversFleet } = useQuery({
    queryKey: ["fleet", "servers", "", ""],
    queryFn: ({ signal }) => Fleet.servers({}, signal),
  });
  const serversList = { items: (serversFleet?.items ?? []).map(located) };

  const items = useMemo(() => restores?.items ?? [], [restores]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((r) => {
      if (server && !matchesServer(r, server, serversList.items)) return false;
      if (phase && r.status?.phase !== phase) return false;
      if (q) {
        const hay = `${r.metadata.name} ${r.spec.serverRef.name} ${r.spec.backupRef.name}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, search, server, phase, serversList.items]);

  return (
    <div className="space-y-4">
      <FleetCoverage partial={restoresFleet?.partial} issues={restoresFleet?.issues} error={fleetError} label={intl.formatMessage({ id: "web.routes.backups.restores", defaultMessage: "Restores", description: "Backups: name of the restores tab, also its table label; keep it short" })} />
      {fleetLoading && <p className="text-sm text-muted">{intl.formatMessage({ id: "web.routes.backups.loading_restores", defaultMessage: "Loading restores…", description: "Backups: loading text on the restores tab while restore data is fetched" })}</p>}
      <BackupFilters
        location={location}
        onLocationChange={onLocationChange}
        locations={locations}
        search={search}
        onSearchChange={setSearch}
        server={server}
        onServerChange={setServer}
        phase={phase}
        onPhaseChange={setPhase}
        servers={serversList?.items ?? []}
        phases={RESTORE_PHASES}
        trailing={intl.formatMessage(TRAILING_COUNT.restores, { shown: filtered.length, total: items.length })}
      />
      <div className={TABLE_FRAME}>
        <Table.Root className="bg-transparent">
          <Table.ScrollContainer>
            <Table.Content aria-label={intl.formatMessage({ id: "web.routes.backups.restores", defaultMessage: "Restores", description: "Backups: name of the restores tab, also its table label; keep it short" })} keyboardNavigationBehavior="arrow">
              <Table.Header>
                <Table.Column key="name" isRowHeader>
                  {intl.formatMessage({ id: "web.routes.backups.name", defaultMessage: "Name", description: "Backups: column heading for the name of each backup, schedule or restore; keep it short" })}
                </Table.Column>
                <Table.Column key="backup">{intl.formatMessage({ id: "web.routes.backups.backup", defaultMessage: "Backup", description: "Backups: column heading for the backup a restore came from; keep it short" })}</Table.Column>
                <Table.Column key="target">{intl.formatMessage({ id: "web.routes.backups.target", defaultMessage: "Target", description: "Backups: column heading for the target a restore was applied to; keep it short" })}</Table.Column>
                <Table.Column key="phase">{intl.formatMessage({ id: "web.routes.backups.status", defaultMessage: "Status", description: "Backups: column heading for the status of each backup or restore; keep it short" })}</Table.Column>
                <Table.Column key="completed">{intl.formatMessage({ id: "web.routes.backups.completed", defaultMessage: "Completed", description: "Backups: column heading for when a backup or restore completed; keep it short" })}</Table.Column>
                <Table.Column key="message">{intl.formatMessage({ id: "web.routes.backups.message", defaultMessage: "Message", description: "Backups: column heading for the status message of a restore; keep it short" })}</Table.Column>
              </Table.Header>
              <Table.Body
                renderEmptyState={() =>
                  items.length > 0 ? (
                    <EmptyState icon={<History />} title={intl.formatMessage({ id: "web.routes.backups.no_restores_match_the_current_filters", defaultMessage: "No restores match the current filters.", description: "Backups: restores empty state when filters hide every restore" })} />
                  ) : restoresFleet?.partial || fleetError ? (
                    <EmptyState icon={<History />} title={intl.formatMessage({ id: "web.routes.backups.no_restore_data_available", defaultMessage: "No restore data available.", description: "Backups: restores empty state when the list could not be loaded" })} />
                  ) : (
                    <EmptyState icon={<History />} title={intl.formatMessage({ id: "web.routes.backups.no_restores_have_been_run", defaultMessage: "No restores have been run.", description: "Backups: restores empty state when no restore has run" })} hint={intl.formatMessage({ id: "web.routes.backups.open_a_backup_and_choose_restore", defaultMessage: "Open a backup and choose Restore to roll a server back to that snapshot.", description: "Backups: hint under the empty restores state explaining how to start a restore from a backup" })} />
                  )
                }
              >
                {filtered.map((r) => (
                  <Table.Row key={targetKey(r.fleetTarget)}>
                    <Table.Cell>
                      <span className="font-mono text-xs">{r.metadata.name}</span><div className="text-xs text-muted">{targetLabel(r.fleetTarget)}</div>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="font-mono text-xs">{r.spec.backupRef.name}</span>
                    </Table.Cell>
                    <Table.Cell className="font-medium">{r.spec.serverRef.name}</Table.Cell>
                    <Table.Cell>
                      <PhaseChip phase={r.status?.phase} />
                    </Table.Cell>
                    <Table.Cell className="text-foreground/60">
                      <span title={r.status?.completionTime}>{formatRelative(r.status?.completionTime, intl)}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="block max-w-xs truncate text-xs text-foreground/60" title={r.status?.message}>{r.status?.message ?? intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" })}</span>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table.Root>
      </div>
    </div>
  );
}

function hasPermission(permissions: string[] | undefined, permission: string): boolean {
  return permissions?.includes(permission) === true || permissions?.includes("*") === true;
}

function matchesServer(resource: Located<Backup> | Located<BackupSchedule> | Located<import("@/types").Restore>, key: string, servers: Located<import("@/types").GameServer>[]): boolean {
  const server = servers.find((item) => targetKey(item.fleetTarget) === key);
  return !!server && resource.fleetTarget.cluster === server.fleetTarget.cluster && resource.fleetTarget.namespace === server.fleetTarget.namespace && resource.spec.serverRef?.name === server.metadata.name;
}
