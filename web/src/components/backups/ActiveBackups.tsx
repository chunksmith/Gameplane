import { Card } from "@heroui/react";
import { Activity, Hourglass } from "lucide-react";
import { PhaseChip } from "@/components/ui/PhaseChip";
import { formatBytes, formatRelative } from "@/lib/utils";
import { SCHEDULE_LABEL, formatDuration } from "@/lib/backupGroups";
import { targetKey, type Located } from "@/lib/fleet";
import type { Backup } from "@/types";
import { useFormat, useOptionalIntl } from "@/lib/i18n/format";

export function isActiveBackup(backup: Backup): boolean {
  const phase = backup.status?.phase;
  return !phase || phase === "Queued" || phase === "Pending" || phase === "Running";
}

const takenAt = (backup: Backup) => Date.parse(backup.metadata.creationTimestamp ?? "") || 0;

export const newestBackupFirst = (a: Backup, b: Backup) => takenAt(b) - takenAt(a);

export function BackupProgressBar({ backup, compact = false }: { backup: Backup; compact?: boolean }) {
  const intl = useOptionalIntl();
  const fmt = useFormat();
  const progress = backup.status?.progress;
  const phase = backup.status?.phase;
  const pct = progress?.percentDone ?? 0;
  const indeterminate = phase !== "Running" || !progress;
  const details = [
    progress?.totalBytes ? intl.formatMessage({ id: "web.components.backups.active_backups.bytes_done_of_total", defaultMessage: "{done} of {total}", description: "Active backups: progress of a running backup as copied size out of total size; {done} and {total} are formatted sizes" }, { done: formatBytes(progress.bytesDone ?? 0), total: formatBytes(progress.totalBytes) }) : null,
    !compact && progress?.totalFiles ? intl.formatMessage({ id: "web.components.backups.active_backups.files_done_of_total", defaultMessage: "{done} / {total} files", description: "Active backups: progress of a running backup as files copied out of total files; {done} and {total} are formatted counts" }, { done: fmt.number(progress.filesDone ?? 0), total: fmt.number(progress.totalFiles) }) : null,
    progress?.secondsRemaining ? intl.formatMessage({ id: "web.components.backups.active_backups.time_left", defaultMessage: "~{duration} left", description: "Active backups: estimated time remaining of a running backup; {duration} is a formatted duration such as 5 min" }, { duration: formatDuration(progress.secondsRemaining, intl) }) : null,
  ].filter(Boolean);
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="truncate text-muted">
          {phase === "Queued"
            ? backup.status?.message ?? intl.formatMessage({ id: "web.components.backups.active_backups.waiting_for_a_free_slot", defaultMessage: "Waiting for a free slot", description: "Active backups: status text of a queued backup that waits for a free backup slot; keep it short" })
            : phase === "Running"
              ? details.join(" · ") || intl.formatMessage({ id: "web.components.backups.active_backups.scanning_files", defaultMessage: "Scanning files…", description: "Active backups: status text of a running backup before its size and file counts are known" })
              : intl.formatMessage({ id: "web.components.backups.active_backups.preparing", defaultMessage: "Preparing…", description: "Active backups: status text of a backup that is starting and has no progress yet" })}
        </span>
        {!indeterminate && <span className="font-mono text-foreground">{intl.formatMessage({ id: "web.components.backups.active_backups.percent_done", defaultMessage: "{percent}%", description: "Active backups: percent complete of a running backup, shown beside its progress bar; {percent} is the number" }, { percent: pct })}</span>}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-default">
        {indeterminate ? (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-accent/40" />
        ) : (
          <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${Math.max(2, pct)}%` }} />
        )}
      </div>
    </div>
  );
}

export function ActiveBackups({ backups, onSelect }: { backups: Located<Backup>[]; onSelect: (backup: Located<Backup>) => void }) {
  const intl = useOptionalIntl();
  if (backups.length === 0) return null;
  const order = { Running: 0, Pending: 1, Queued: 2 } as Record<string, number>;
  const sorted = [...backups].sort((a, b) => (order[a.status?.phase ?? "Pending"] ?? 1) - (order[b.status?.phase ?? "Pending"] ?? 1));
  return (
    <Card className="border border-border bg-surface p-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Activity className="h-4 w-4 text-accent" />
        <span className="text-sm font-semibold">{intl.formatMessage({ id: "web.components.backups.active_backups.in_progress", defaultMessage: "In progress", description: "Active backups: heading above the list of running and queued backups; keep it short" })}</span>
        <span className="rounded-full bg-accent/10 px-2 py-0.5 font-mono text-[11px] text-accent">{backups.length}</span>
      </div>
      <ul className="divide-y divide-border">
        {sorted.map((backup) => (
          <li key={targetKey(backup.fleetTarget)}>
            <button
              type="button"
              onClick={() => onSelect(backup)}
              className="grid w-full grid-cols-1 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-default/40 md:grid-cols-[220px_1fr_auto]"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{backup.spec.serverRef.name}</div>
                <div className="flex items-center gap-1 truncate text-xs text-muted">
                  {backup.status?.phase === "Queued" && <Hourglass className="h-3 w-3" />}
                  {backup.metadata.labels?.[SCHEDULE_LABEL] ?? intl.formatMessage({ id: "web.components.backups.active_backups.manual", defaultMessage: "manual", description: "Active backups: label shown in place of a schedule name for a backup started by hand; keep it short" })}
                  {backup.status?.startTime && <> {intl.formatMessage({ id: "web.components.backups.active_backups.started_time", defaultMessage: "· started {time}", description: "Active backups: text after the schedule name giving when the backup started; {time} is a relative time such as 5 min ago" }, { time: formatRelative(backup.status.startTime, intl) })}</>}
                </div>
              </div>
              <BackupProgressBar backup={backup} />
              <PhaseChip phase={backup.status?.phase} />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
