import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { CalendarClock, CheckCircle2, Layers, Loader2, Plus } from "lucide-react";
import { createResourceClient } from "@/lib/endpoints";
import { useFleetLocation, Fleet, located, targetKey, targetLabel, type Located } from "@/lib/fleet";
import { FleetCoverage } from "@/components/FleetScope";
import {
  Button,
  Card,
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
import { formatRelative, formatRelativeFuture } from "@/lib/utils";
import { PhaseChip } from "@/components/ui/PhaseChip";
import { ErrorBanner } from "@/components/backups/ErrorBanner";
import { ScheduleForm } from "@/components/backups/ScheduleForm";
import { RestoreDialog } from "@/components/backups/RestoreDialog";
import { BackupDetailDrawer } from "@/components/backups/BackupDetailDrawer";
import { BackupRow } from "@/components/backups/BackupRow";
import { BackupFilters } from "@/components/backups/BackupFilters";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatCard } from "@/components/ui/StatCard";
import { ActiveBackups, isActiveBackup } from "@/components/backups/ActiveBackups";
import { BackupGroupsPanel, groupMembers } from "@/components/backups/BackupGroupsPanel";
import type { Backup, BackupSchedule } from "@/types";

type TabKey = "backups" | "groups" | "schedules" | "restores";
const TABS: { id: TabKey; label: string }[] = [
  { id: "backups", label: "Backups" },
  { id: "groups", label: "Groups" },
  { id: "schedules", label: "Server schedules" },
  { id: "restores", label: "Restores" },
];

const BACKUP_PHASES = ["Queued", "Pending", "Running", "Succeeded", "Failed"];
const DAY = 24 * 60 * 60 * 1000;
const RESTORE_PHASES = ["Pending", "Suspending", "Running", "Resuming", "Succeeded", "Failed"];

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
  const covered = new Set(groupSchedules.filter((s) => !s.spec.suspend).flatMap((s) => groupMembers(s, allServers).map((server) => targetKey(server.fleetTarget))));
  const nextRun = allSchedules
    .filter((s) => !s.spec.suspend && s.status?.nextScheduleTime)
    .sort((a, b) => Date.parse(a.status!.nextScheduleTime!) - Date.parse(b.status!.nextScheduleTime!))[0];

  return (
    <div className="space-y-5 p-6">
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
          label="Group coverage"
          value={`${covered.size}/${allServers.length}`}
          sub={`${groupSchedules.length} group ${groupSchedules.length === 1 ? "schedule" : "schedules"}`}
          icon={<Layers />}
          accent={covered.size < allServers.length ? "warning" : "violet"}
        />
        <StatCard
          label="Next run"
          value={nextRun ? formatRelativeFuture(nextRun.status?.nextScheduleTime) : "—"}
          sub={nextRun?.metadata.name ?? "No active schedules"}
          icon={<CalendarClock />}
        />
      </div>
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
      <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(key as TabKey)}>
        <Tabs.List>
          {TABS.map((t) => (
            <Tab key={t.id} id={t.id}>
              {t.label}
            </Tab>
          ))}
        </Tabs.List>
      </Tabs>
      {tab === "backups" && <BackupsTabPanel location={location} onLocationChange={setLocation} locations={locations} />}
      {tab === "groups" && <BackupGroupsPanel schedules={allSchedules} servers={allServers} />}
      {tab === "schedules" && <SchedulesTabPanel location={location} onLocationChange={setLocation} locations={locations} />}
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
    });
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

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <Table.Root>
          <Table.ScrollContainer>
            <Table.Content aria-label="Backups" keyboardNavigationBehavior="arrow">
              <Table.Header>
                <Table.Column key="name" isRowHeader>
                  Name
                </Table.Column>
                <Table.Column key="server">Server</Table.Column>
                <Table.Column key="phase">Phase</Table.Column>
                <Table.Column key="progress">Progress</Table.Column>
                <Table.Column key="size">Size</Table.Column>
                <Table.Column key="completed">Completed</Table.Column>
                <Table.Column key="actions" className="text-end" />
              </Table.Header>
              <Table.Body
                renderEmptyState={() => (
                  <>
                    {items.length === 0
                      ? (backupsFleet?.partial || fleetError ? "No backup data available." : 'No backups yet. Use "Back up now" to create the first one.')
                      : "No backups match the current filters."}
                  </>
                )}
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
          <ModalDialog>
            <ModalHeader>
              <ModalHeading>Back up now</ModalHeading>
            </ModalHeader>
            <ModalBody className="gap-4">
              <p className="text-sm text-foreground/60">Run a one-off snapshot outside any schedule.</p>
              <div className="space-y-4">
                <div>
                  <Select
                    value={createServer}
                    onChange={(v) => { setCreateServer(v as string); setCreateDest(""); }}
                    placeholder="Select a server…"
                    aria-label="Server"
                    className="mt-1"
                  >
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
                </div>
                {destinations.length > 1 && (
                  <div>
                    <Select
                      value={createDest}
                      onChange={(v) => setCreateDest(v as string)}
                      placeholder="Select a destination…"
                      aria-label="Destination"
                      className="mt-1"
                    >
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
                  </div>
                )}
                {noDestinations && (
                  <p className="text-xs text-foreground/60">
                    No backup destinations configured. Add one in{" "}
                    <Link to="/admin" className="text-primary hover:underline">
                      admin settings
                    </Link>{" "}
                    to enable snapshots.
                  </p>
                )}
                {createNow.error && <ErrorBanner err={createNow.error} />}
              </div>
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

function SchedulesTabPanel({ location, onLocationChange, locations }: LocationFilterProps) {
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
      <Card className="p-4">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="text-xs font-medium">New schedule for</label>
            <Select
              value={creatingFor}
              onChange={(v) => setCreatingFor(v as string)}
              placeholder="Select a server…"
              aria-label="Select a server"
              className="mt-1"
            >
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
          </div>
        </div>
      </Card>

      {selectedServer && (
        <ScheduleForm target={selectedServer.fleetTarget} permissions={selectedServer.fleetPermissions} serverName={selectedServer.metadata.name} onClose={() => setCreatingFor("")} />
      )}
      {toggleSuspend.error && <ErrorBanner err={toggleSuspend.error} />}
      {remove.error && <ErrorBanner err={remove.error} />}

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <Table.Root>
          <Table.ScrollContainer>
            <Table.Content aria-label="Schedules" keyboardNavigationBehavior="arrow">
              <Table.Header>
                <Table.Column key="name" isRowHeader>
                  Name
                </Table.Column>
                <Table.Column key="server">Server</Table.Column>
                <Table.Column key="cron">Cron</Table.Column>
                <Table.Column key="lastrun">Last run</Table.Column>
                <Table.Column key="nextrun">Next run</Table.Column>
                <Table.Column key="active">Active</Table.Column>
                <Table.Column key="actions" className="text-end" />
              </Table.Header>
              <Table.Body renderEmptyState={() => <>{items.length > 0 ? "No schedules match the current filters." : schedulesFleet?.partial || fleetError ? "No schedule data available." : "No schedules configured yet."}</>}>
                {filtered.map((s) => (
                  <Table.Row key={targetKey(s.fleetTarget)}>
                    <Table.Cell>
                      <span className="font-mono text-xs">{s.metadata.name}</span><div className="text-xs text-muted">{targetLabel(s.fleetTarget)}</div>
                    </Table.Cell>
                    <Table.Cell>{s.spec.serverRef?.name}</Table.Cell>
                    <Table.Cell>
                      <span className="font-mono text-xs">{s.spec.schedule}</span>
                    </Table.Cell>
                    <Table.Cell className="text-foreground/60">
                      {formatRelative(s.status?.lastSuccessfulTime)}
                    </Table.Cell>
                    <Table.Cell className="text-foreground/60">
                      {s.spec.suspend ? "—" : formatRelativeFuture(s.status?.nextScheduleTime)}
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
                    <Table.Cell>
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={!hasPermission(s.fleetPermissions, "schedules:write")}
                        onPress={() => setDeleting(s)}
                      >
                        Delete
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
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <Table.Root>
          <Table.ScrollContainer>
            <Table.Content aria-label="Restores" keyboardNavigationBehavior="arrow">
              <Table.Header>
                <Table.Column key="name" isRowHeader>
                  Name
                </Table.Column>
                <Table.Column key="backup">Backup</Table.Column>
                <Table.Column key="target">Target</Table.Column>
                <Table.Column key="phase">Phase</Table.Column>
                <Table.Column key="completed">Completed</Table.Column>
                <Table.Column key="message">Message</Table.Column>
              </Table.Header>
              <Table.Body
                renderEmptyState={() => (
                  <>
                    {items.length === 0
                      ? (restoresFleet?.partial || fleetError ? "No restore data available." : "No restores have been run.")
                      : "No restores match the current filters."}
                  </>
                )}
              >
                {filtered.map((r) => (
                  <Table.Row key={targetKey(r.fleetTarget)}>
                    <Table.Cell>
                      <span className="font-mono text-xs">{r.metadata.name}</span><div className="text-xs text-muted">{targetLabel(r.fleetTarget)}</div>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="font-mono text-xs">{r.spec.backupRef.name}</span>
                    </Table.Cell>
                    <Table.Cell>{r.spec.serverRef.name}</Table.Cell>
                    <Table.Cell>
                      <PhaseChip phase={r.status?.phase} />
                    </Table.Cell>
                    <Table.Cell className="text-foreground/60">
                      {formatRelative(r.status?.completionTime)}
                    </Table.Cell>
                    <Table.Cell className="text-xs text-foreground/60">
                      {r.status?.message ?? "—"}
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
