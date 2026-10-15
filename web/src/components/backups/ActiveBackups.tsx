import { Card } from "@heroui/react";
import { Activity, Hourglass } from "lucide-react";
import { PhaseChip } from "@/components/ui/PhaseChip";
import { formatBytes, formatRelative } from "@/lib/utils";
import { SCHEDULE_LABEL, formatDuration } from "@/lib/backupGroups";
import { targetKey, type Located } from "@/lib/fleet";
import type { Backup } from "@/types";

export function isActiveBackup(backup: Backup): boolean {
  const phase = backup.status?.phase;
  return !phase || phase === "Queued" || phase === "Pending" || phase === "Running";
}

export function BackupProgressBar({ backup, compact = false }: { backup: Backup; compact?: boolean }) {
  const progress = backup.status?.progress;
  const phase = backup.status?.phase;
  const pct = progress?.percentDone ?? 0;
  const indeterminate = phase !== "Running" || !progress;
  const details = [
    progress?.totalBytes ? `${formatBytes(progress.bytesDone ?? 0)} of ${formatBytes(progress.totalBytes)}` : null,
    !compact && progress?.totalFiles ? `${(progress.filesDone ?? 0).toLocaleString()} / ${progress.totalFiles.toLocaleString()} files` : null,
    progress?.secondsRemaining ? `~${formatDuration(progress.secondsRemaining)} left` : null,
  ].filter(Boolean);
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="truncate text-muted">
          {phase === "Queued"
            ? backup.status?.message ?? "Waiting for a free slot"
            : phase === "Running"
              ? details.join(" · ") || "Scanning files…"
              : "Preparing…"}
        </span>
        {!indeterminate && <span className="font-mono text-foreground">{pct}%</span>}
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
  if (backups.length === 0) return null;
  const order = { Running: 0, Pending: 1, Queued: 2 } as Record<string, number>;
  const sorted = [...backups].sort((a, b) => (order[a.status?.phase ?? "Pending"] ?? 1) - (order[b.status?.phase ?? "Pending"] ?? 1));
  return (
    <Card className="border border-border bg-surface p-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Activity className="h-4 w-4 text-accent" />
        <span className="text-sm font-semibold">In progress</span>
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
                  {backup.metadata.labels?.[SCHEDULE_LABEL] ?? "manual"}
                  {backup.status?.startTime && ` · started ${formatRelative(backup.status.startTime)}`}
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
