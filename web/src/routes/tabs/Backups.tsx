import { useResourceClient, useResourceTarget, resourceKey, useResourcePermissions, resourceCan } from "@/lib/resourceTarget";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, CalendarClock, Clock, HardDrive } from "lucide-react";
import { Button, Chip, Table } from "@heroui/react";
import { StatCard } from "@/components/ui/StatCard";
import { PhaseChip } from "@/components/ui/PhaseChip";

import { useBackupDestinations } from "@/lib/destinations";
import { formatBytes, formatRelative, formatRelativeFuture, formatSize, parseQuantityToBytes } from "@/lib/utils";
import { ErrorBanner } from "@/components/backups/ErrorBanner";
import { ScheduleForm } from "@/components/backups/ScheduleForm";
import { RestoreDialog } from "@/components/backups/RestoreDialog";
import { BackupDetailDrawer } from "@/components/backups/BackupDetailDrawer";
import { BackupProgressBar, isActiveBackup, newestBackupFirst } from "@/components/backups/ActiveBackups";
import type { Backup } from "@/types";

export function BackupsTab({ name, ns }: { name: string; ns?: string }) {
  const resourceTarget = useResourceTarget({ name, namespace: ns });
  const resourceClient = useResourceClient(resourceTarget);
  const { Backups } = resourceClient;
  const qc = useQueryClient();
  const permissions = useResourcePermissions();
  const [creatingSchedule, setCreatingSchedule] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState<Backup | null>(null);
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null);

  const { data: backups, error: backupsError } = useQuery({
    queryKey: resourceKey(resourceTarget, "backups", ns),
    queryFn: ({ signal }) => resourceClient.withSignal(signal).Backups.list(ns),
    refetchInterval: 5000,
  });
  const { data: schedules, error: schedulesError } = useQuery({
    queryKey: resourceKey(resourceTarget, "schedules", ns),
    queryFn: ({ signal }) => resourceClient.withSignal(signal).Schedules.list(ns),
  });
  const { data: restores, error: restoresError } = useQuery({
    queryKey: resourceKey(resourceTarget, "restores", ns),
    queryFn: ({ signal }) => resourceClient.withSignal(signal).Restores.list(ns),
    refetchInterval: 5000,
  });
  const { data: destinations = [] } = useBackupDestinations();

  // Multi-destination picking is handled on the dashboard's Backups page;
  // here we only act when there's exactly one configured destination.
  const lone = destinations.length === 1 ? destinations[0] : null;

  const createNow = useMutation({
    mutationFn: () =>
      Backups.create(
        {
          serverRef: { name },
          repoRef: { name: lone!.name, key: "repo" },
        },
        ns,
      ),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: resourceKey(resourceTarget, "backups", ns) }), qc.invalidateQueries({ queryKey: ["fleet"] })]),
  });

  const backupNowDisabled = !resourceCan(permissions, "backups:write") || !lone || createNow.isPending;
  const backupNowHint =
    destinations.length === 0
      ? "No backup destination configured. Add one in admin settings."
      : destinations.length > 1
        ? "Multiple destinations configured — use the Backups page to pick one."
        : undefined;

  const serverBackups = backups?.items.filter((b) => b.spec.serverRef.name === name).sort(newestBackupFirst) ?? [];
  const serverSchedules = schedules?.items.filter((s) => s.spec.serverRef?.name === name) ?? [];
  const serverRestores = restores?.items.filter((r) => r.spec.serverRef.name === name) ?? [];

  // Summary tiles, derived from the same lists the table renders.
  const succeeded = serverBackups.filter((b) => b.status?.phase === "Succeeded");
  const completions = succeeded
    .map((b) => b.status?.completionTime)
    .filter((t): t is string => Boolean(t))
    .sort();
  const lastBackupAt = completions[completions.length - 1];
  const nextRuns = serverSchedules
    .filter((s) => !s.spec.suspend)
    .map((s) => s.status?.nextScheduleTime)
    .filter((t): t is string => Boolean(t))
    .sort();
  const nextBackupAt = nextRuns[0];
  const totalBytes = succeeded.reduce((acc, b) => acc + parseQuantityToBytes(b.status?.size), 0);

  return (
    <div className="space-y-6 p-6">
      {backupsError && <ErrorBanner err={backupsError} />}
      {schedulesError && <ErrorBanner err={schedulesError} />}
      {restoresError && <ErrorBanner err={restoresError} />}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Last backup"
          value={backupsError ? "Unavailable" : formatRelative(lastBackupAt)}
          icon={<Clock size={16} />}
          accent="primary"
        />
        <StatCard
          label="Next backup"
          value={schedulesError ? "Unavailable" : nextBackupAt ? formatRelativeFuture(nextBackupAt) : "—"}
          icon={<CalendarClock size={16} />}
          accent="success"
        />
        <StatCard
          label="Backups"
          value={backups ? serverBackups.length : "—"}
          icon={<Archive size={16} />}
          accent="violet"
        />
        <StatCard
          label="Total size"
          value={backupsError ? "Unavailable" : totalBytes ? formatBytes(totalBytes) : "—"}
          icon={<HardDrive size={16} />}
          accent="warning"
        />
      </div>

      <section>
        <div className="flex items-center justify-between pb-3">
          <h2 className="text-sm text-foreground/60">Schedules</h2>
          <Button
            size="sm"
            variant="outline"
            onPress={() => setCreatingSchedule(true)}
            isDisabled={creatingSchedule || !resourceCan(permissions, "schedules:write")}
          >
            New schedule
          </Button>
        </div>
        {creatingSchedule && (
          <ScheduleForm serverName={name} ns={ns} onClose={() => setCreatingSchedule(false)} />
        )}
        {serverSchedules.length > 1 && (
          <div className="mb-3 rounded border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-foreground/60">
            This server has multiple backup schedules — consider consolidating to avoid duplicate backups.
          </div>
        )}
        <div className="space-y-1 pt-2">
          {serverSchedules.map((s) => {
            const isAutoManaged = s.metadata.name === `${name}-auto`;
            return (
              <div
                key={s.metadata.name}
                className="flex items-center justify-between rounded border border-border bg-surface/30 px-4 py-2 text-sm"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono">{s.spec.schedule}</span>
                  {isAutoManaged && (
                    <Chip size="sm" color="default" variant="soft">
                      Managed by server settings
                    </Chip>
                  )}
                </div>
                <span className="text-foreground/60">
                  Next: {formatRelativeFuture(s.status?.nextScheduleTime)}
                </span>
              </div>
            );
          })}
          {schedules && serverSchedules.length === 0 && !creatingSchedule && (
            <p className="text-sm text-foreground/60">No schedules yet.</p>
          )}
        </div>
      </section>

      {serverRestores.length > 0 && (
        <section>
          <h2 className="pb-3 text-sm text-foreground/60">Recent restores</h2>
          <div className="space-y-1">
            {serverRestores.map((r) => (
              <div
                key={r.metadata.name}
                className="flex justify-between rounded border border-border bg-surface/30 px-4 py-2 text-sm"
              >
                <span className="font-mono">{r.spec.backupRef.name}</span>
                <span className="text-foreground/60">
                  <PhaseChip phase={r.status?.phase} />
                  {r.status?.completionTime &&
                    ` · ${formatRelative(r.status.completionTime)}`}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="flex items-center justify-between pb-3">
          <h2 className="text-sm text-foreground/60">Backups</h2>
          {/* The disabled reason lives on a wrapping element's title
              (react-aria's Button strips a bare `title` prop) so the
              button's accessible name stays its visible text. */}
          <span title={backupNowHint}>
            <Button
              size="sm"
              onPress={() => createNow.mutate()}
              isDisabled={backupNowDisabled}
            >
              {createNow.isPending ? "Starting…" : "Back up now"}
            </Button>
          </span>
        </div>
        {createNow.error && <ErrorBanner err={createNow.error} />}
        <Table.Root>
          <Table.ScrollContainer>
            <Table.Content aria-label="Backups table" keyboardNavigationBehavior="arrow">
              <Table.Header>
                <Table.Column key="name" isRowHeader>Name</Table.Column>
                <Table.Column key="phase">Phase</Table.Column>
                <Table.Column key="progress">Progress</Table.Column>
                <Table.Column key="size">Size</Table.Column>
                <Table.Column key="completed">Completed</Table.Column>
                <Table.Column key="actions" id="actions" className="text-end">Actions</Table.Column>
              </Table.Header>
              <Table.Body>
                {serverBackups.map((b) => {
                  const restorable =
                    b.status?.phase === "Succeeded" && Boolean(b.status?.snapshotID);
                  return (
                    <Table.Row
                      key={b.metadata.name}
                      className="cursor-pointer"
                      onAction={() => setSelectedBackup(b.metadata.name)}
                    >
                      <Table.Cell className="font-mono">{b.metadata.name}</Table.Cell>
                      <Table.Cell>
                        <PhaseChip phase={b.status?.phase} />
                      </Table.Cell>
                      <Table.Cell>
                        {isActiveBackup(b) ? <div className="w-48"><BackupProgressBar backup={b} compact /></div> : "—"}
                      </Table.Cell>
                      <Table.Cell className="font-mono">{formatSize(b.status?.size)}</Table.Cell>
                      <Table.Cell className="font-mono text-foreground/60">
                        {formatRelative(b.status?.completionTime)}
                      </Table.Cell>
                      <Table.Cell onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            isDisabled={!restorable || !resourceCan(permissions, "*")}
                            onPress={() => setRestoringBackup(b)}
                          >
                            Restore
                          </Button>
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table.Root>
      </section>

      <RestoreDialog
        backup={restoringBackup}
        defaultServer={name}
        ns={ns}
        onClose={() => setRestoringBackup(null)}
      />
      <BackupDetailDrawer
        name={selectedBackup}
        ns={ns}
        onClose={() => setSelectedBackup(null)}
        onRestore={(b) => {
          setSelectedBackup(null);
          setRestoringBackup(b);
        }}
      />
    </div>
  );
}
