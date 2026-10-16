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

type TabKey = "backups" | "groups" | "schedules" | "restores";
const TABS: { id: TabKey; label: string; icon: ReactNode }[] = [
  { id: "backups", label: "Backups", icon: <Archive className="h-4 w-4" /> },
  { id: "groups", label: "Groups", icon: <Layers className="h-4 w-4" /> },
  { id: "schedules", label: "Server schedules", icon: <CalendarClock className="h-4 w-4" /> },
  { id: "restores", label: "Restores", icon: <History className="h-4 w-4" /> },
];

const BACKUP_PHASES = ["Queued", "Pending", "Running", "Succeeded", "Failed"];
const DAY = 24 * 60 * 60 * 1000;
const RESTORE_PHASES = ["Pending", "Suspending", "Running", "Resuming", "Succeeded", "Failed"];
const TABLE_FRAME = "overflow-hidden rounded-lg border border-border bg-card";

export function BackupsPage() {
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
        title="Backups"
        subtitle="Snapshots, group schedules, and restores across your authorized locations."
        actions={
          <Button onPress={() => setBackupNow(true)}>
            <Plus className="h-4 w-4" /> Back up now
          </Button>
        }
      />
      {backupNow && <BackupNowDialog onClose={() => setBackupNow(false)} />}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Running"
          value={active.filter((b) => b.status?.phase === "Running").length}
          sub={`${active.filter((b) => b.status?.phase === "Queued").length} queued`}
          icon={<Loader2 className={active.some((b) => b.status?.phase === "Running") ? "animate-spin" : ""} />}
        />
        <StatCard
          label="Last 24h"
          value={recent.filter((b) => b.status?.phase === "Succeeded").length}
          sub={`${recent.filter((b) => b.status?.phase === "Failed").length} failed`}
          icon={<CheckCircle2 />}
          accent={recent.some((b) => b.status?.phase === "Failed") ? "danger" : "success"}
        />
        <StatCard
          label="Protected"
          value={coverageKnown ? `${allServers.length - unprotected.length}/${allServers.length}` : "—"}
          sub={`${activeSchedules} active ${activeSchedules === 1 ? "schedule" : "schedules"}`}
          icon={unprotected.length > 0 ? <ShieldAlert /> : <ShieldCheck />}
          accent={unprotected.length > 0 ? "warning" : "success"}
        />
        <StatCard
          label="Next run"
          value={nextRun ? formatRelativeFuture(nextRun.status?.nextScheduleTime) : "—"}
          sub={nextRun?.metadata.name ?? "No active schedules"}
          icon={<CalendarClock />}
        />
      </div>
      {unprotected.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 sm:flex-row sm:items-center">
          <ShieldAlert className="h-5 w-5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-warning-soft-foreground">
              {unprotected.length === 1 ? "1 server has" : `${unprotected.length} servers have`} no automatic backups
            </div>
            <div className="truncate text-xs text-muted">{unprotected.map((server) => server.metadata.name).join(", ")}</div>
          </div>
          {tab !== "groups" && (
            <Button size="sm" variant="outline" onPress={() => setTab("groups")}>
              Set up a group schedule
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
          <Tabs.List aria-label="Backup sections" className="servers-status-filter">
            {TABS.map((t) => (
              <Tab key={t.id} id={t.id}>
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  {t.icon}
                  {t.label}
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
      <FleetCoverage partial={backupsFleet?.partial} issues={backupsFleet?.issues} error={fleetError} label="Backups" />
      {fleetLoading && <p className="text-sm text-muted">Loading backups…</p>}
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
        trailing={`${filtered.length} of ${items.length} ${items.length === 1 ? "backup" : "backups"}`}
      />

      <div className={TABLE_FRAME}>
        <Table.Root className="bg-transparent">
          <Table.ScrollContainer>
            <Table.Content aria-label="Backups" keyboardNavigationBehavior="arrow">
              <Table.Header>
                <Table.Column key="name" isRowHeader>
                  Backup
                </Table.Column>
                <Table.Column key="server">Server</Table.Column>
                <Table.Column key="phase">Status</Table.Column>
                <Table.Column key="progress">Progress</Table.Column>
                <Table.Column key="size">Size</Table.Column>
                <Table.Column key="completed">Completed</Table.Column>
                <Table.Column key="actions" className="text-end" />
              </Table.Header>
              <Table.Body
                renderEmptyState={() =>
                  items.length > 0 ? (
                    <EmptyState icon={<Archive />} title="No backups match the current filters." hint="Clear the search or filters to see every snapshot." />
                  ) : backupsFleet?.partial || fleetError ? (
                    <EmptyState icon={<Archive />} title="No backup data available." />
                  ) : (
                    <EmptyState icon={<Archive />} title="No backups yet." hint={'Use "Back up now" to take the first snapshot, or add a schedule so it happens automatically.'} />
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
      if (!selectedServer || !hasPermission(selectedServer.fleetPermissions, "backups:write")) throw new Error("Select a server with backup access.");
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
                <ModalHeading>Back up now</ModalHeading>
                <p className="text-sm text-muted">Run a one-off snapshot outside any schedule.</p>
              </div>
            </ModalHeader>
            <ModalBody className="gap-4">
              <Select
                value={createServer}
                onChange={(v) => { setCreateServer(v as string); setCreateDest(""); }}
                placeholder="Select a server…"
                className="space-y-1.5"
              >
                <Label className="text-xs">Server</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator className="ml-auto h-4 w-4" />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox aria-label="Server options">
                    {(serversList?.items ?? []).filter((item) => hasPermission(item.fleetPermissions, "backups:write")).map((s) => (
                      <ListBoxItem key={targetKey(s.fleetTarget)} id={targetKey(s.fleetTarget)} textValue={`${s.metadata.name} · ${targetLabel(s.fleetTarget)}`}>
                        {s.metadata.name} · {targetLabel(s.fleetTarget)}
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              {destinations.length > 1 && (
                <Select
                  value={createDest}
                  onChange={(v) => setCreateDest(v as string)}
                  placeholder="Select a destination…"
                  className="space-y-1.5"
                >
                  <Label className="text-xs">Destination</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator className="ml-auto h-4 w-4" />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox aria-label="Destination options">
                      {destinations.map((d) => (
                        <ListBoxItem key={d.name} id={d.name} textValue={d.name}>{d.name}</ListBoxItem>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              )}
              {noDestinations && (
                <p className="rounded-lg bg-default/40 px-3 py-2 text-xs text-muted">
                  No backup destinations configured. Add one in{" "}
                  <Link to="/admin" className="text-primary hover:underline">
                    admin settings
                  </Link>{" "}
                  to enable snapshots.
                </p>
              )}
              {createNow.error && <ErrorBanner err={createNow.error} />}
            </ModalBody>
            <ModalFooter>
              <Button variant="ghost" onPress={onClose} isDisabled={createNow.isPending}>
                Cancel
              </Button>
              <Button
                variant="primary"
                isDisabled={!selectedServer || !createDest || createNow.isPending || noDestinations}
                onPress={() => createNow.mutate()}
              >
                {createNow.isPending ? "Starting…" : "Run snapshot"}
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}

function SchedulesTabPanel({ location, onLocationChange, locations, onOpenGroups }: LocationFilterProps & { onOpenGroups: () => void }) {
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
      <FleetCoverage partial={schedulesFleet?.partial} issues={schedulesFleet?.issues} error={fleetError} label="Schedules" />
      {fleetLoading && <p className="text-sm text-muted">Loading schedules…</p>}
      <Card className="flex flex-col gap-3 border border-dashed border-border bg-transparent p-4 sm:flex-row sm:items-center">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <CalendarPlus className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Add a server schedule</div>
          <p className="text-xs text-muted">
            Back up a single server on its own cron. Covering many servers? A{" "}
            <button type="button" onClick={onOpenGroups} className="text-accent hover:underline">group schedule</button>{" "}
            is easier to manage.
          </p>
        </div>
        <Select
          value={creatingFor}
          onChange={(v) => setCreatingFor(v as string)}
          placeholder="Select a server…"
          className="w-full space-y-1.5 sm:w-72"
        >
          <Label className="text-xs text-muted">New schedule for</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator className="ml-auto h-4 w-4" />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label="Server options">
              {(serversList?.items ?? []).filter((item) => hasPermission(item.fleetPermissions, "schedules:write")).map((s) => (
                <ListBoxItem key={targetKey(s.fleetTarget)} id={targetKey(s.fleetTarget)} textValue={`${s.metadata.name} · ${targetLabel(s.fleetTarget)}`}>
                  {s.metadata.name} · {targetLabel(s.fleetTarget)}
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
        trailing={`${filtered.length} of ${items.length} ${items.length === 1 ? "schedule" : "schedules"}`}
      />

      <div className={TABLE_FRAME}>
        <Table.Root className="bg-transparent">
          <Table.ScrollContainer>
            <Table.Content aria-label="Schedules" keyboardNavigationBehavior="arrow">
              <Table.Header>
                <Table.Column key="name" isRowHeader>
                  Name
                </Table.Column>
                <Table.Column key="server">Server</Table.Column>
                <Table.Column key="cron">Runs</Table.Column>
                <Table.Column key="lastrun">Last run</Table.Column>
                <Table.Column key="nextrun">Next run</Table.Column>
                <Table.Column key="active">Active</Table.Column>
                <Table.Column key="actions" className="text-end" />
              </Table.Header>
              <Table.Body
                renderEmptyState={() =>
                  items.length > 0 ? (
                    <EmptyState icon={<CalendarClock />} title="No schedules match the current filters." />
                  ) : schedulesFleet?.partial || fleetError ? (
                    <EmptyState icon={<CalendarClock />} title="No schedule data available." />
                  ) : (
                    <EmptyState icon={<CalendarClock />} title="No schedules configured yet." hint="Pick a server above to add its first per-server schedule." />
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
                      <div className="text-sm">{describeCron(s.spec.schedule)}</div>
                      {cronPreset(s.spec.schedule) && <div className="font-mono text-xs text-muted">{s.spec.schedule}</div>}
                    </Table.Cell>
                    <Table.Cell className="text-foreground/60">
                      {formatRelative(s.status?.lastSuccessfulTime)}
                    </Table.Cell>
                    <Table.Cell className="text-foreground/60">
                      {s.spec.suspend ? "Paused" : formatRelativeFuture(s.status?.nextScheduleTime)}
                    </Table.Cell>
                    <Table.Cell>
                      <Switch
                        isSelected={!s.spec.suspend}
                        isDisabled={!hasPermission(s.fleetPermissions, "schedules:write") || toggleSuspend.isPending}
                        onChange={(isSelected) =>
                          toggleSuspend.mutate({ item: s, suspend: !isSelected })
                        }
                        aria-label="Schedule active"
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
                        <Trash2 className="h-3.5 w-3.5" /> Delete
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
        title="Delete schedule?"
        description={
          <>
            <p>
              The cron schedule will be removed. Existing backups remain intact;
              new snapshots on this schedule will stop running until it&apos;s recreated.
            </p>
            {deleting && (
              <p className="pt-2">
                Type <span className="font-mono">{deleting.metadata.name}</span> ({targetLabel(deleting.fleetTarget)}) to confirm.
              </p>
            )}
          </>
        }
        confirmPhrase={deleting?.metadata.name}
        confirmLabel="Delete"
        destructive
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

function RestoresTabPanel({ location, onLocationChange, locations }: LocationFilterProps) {
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
      <FleetCoverage partial={restoresFleet?.partial} issues={restoresFleet?.issues} error={fleetError} label="Restores" />
      {fleetLoading && <p className="text-sm text-muted">Loading restores…</p>}
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
        trailing={`${filtered.length} of ${items.length} ${items.length === 1 ? "restore" : "restores"}`}
      />
      <div className={TABLE_FRAME}>
        <Table.Root className="bg-transparent">
          <Table.ScrollContainer>
            <Table.Content aria-label="Restores" keyboardNavigationBehavior="arrow">
              <Table.Header>
                <Table.Column key="name" isRowHeader>
                  Name
                </Table.Column>
                <Table.Column key="backup">Backup</Table.Column>
                <Table.Column key="target">Target</Table.Column>
                <Table.Column key="phase">Status</Table.Column>
                <Table.Column key="completed">Completed</Table.Column>
                <Table.Column key="message">Message</Table.Column>
              </Table.Header>
              <Table.Body
                renderEmptyState={() =>
                  items.length > 0 ? (
                    <EmptyState icon={<History />} title="No restores match the current filters." />
                  ) : restoresFleet?.partial || fleetError ? (
                    <EmptyState icon={<History />} title="No restore data available." />
                  ) : (
                    <EmptyState icon={<History />} title="No restores have been run." hint="Open a backup and choose Restore to roll a server back to that snapshot." />
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
                      <span title={r.status?.completionTime}>{formatRelative(r.status?.completionTime)}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="block max-w-xs truncate text-xs text-foreground/60" title={r.status?.message}>{r.status?.message ?? "—"}</span>
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
