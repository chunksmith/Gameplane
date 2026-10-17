import { useResourcePermissions, resourceCan, type ResourceTarget } from "@/lib/resourceTarget";
import { Button, Table } from "@heroui/react";
import { Archive, RotateCcw } from "lucide-react";
import { cn, formatRelative, formatSize } from "@/lib/utils";
import type { Backup } from "@/types";
import { PhaseChip } from "@/components/ui/PhaseChip";
import { SCHEDULE_LABEL } from "@/lib/backupGroups";
import { BackupProgressBar, isActiveBackup } from "./ActiveBackups";
import { useOptionalIntl } from "@/lib/i18n/format";

const TILE_TONE: Record<string, string> = {
  Succeeded: "bg-success/15 text-success",
  Failed: "bg-danger/15 text-danger",
};

interface Props {
  target?: ResourceTarget;
  permissions?: string[];
  backup: Backup;
  showServer: boolean;
  onSelect: (b: Backup) => void;
  onRestore: (b: Backup) => void;
}

export function BackupRow({ backup, showServer, onSelect, onRestore, target, permissions: explicitPermissions }: Props) {
  const intl = useOptionalIntl();
  const permissions = useResourcePermissions(explicitPermissions);
  const phase = backup.status?.phase;
  const restorable = phase === "Succeeded" && Boolean(backup.status?.snapshotID);
  const failure = phase === "Failed" ? backup.status?.message : undefined;
  return (
    <Table.Row
      className="cursor-pointer"
      onAction={() => onSelect(backup)}
    >
      <Table.Cell>
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", TILE_TONE[phase ?? ""] ?? "bg-accent/15 text-accent")}>
            <Archive className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="truncate font-mono text-xs text-foreground">{backup.metadata.name}</div>
            <div className="truncate text-xs text-muted">
              {backup.metadata.labels?.[SCHEDULE_LABEL] ?? intl.formatMessage({ id: "web.components.backups.backup_row.manual", defaultMessage: "manual", description: "Backup row: subtitle under the backup name when it was made by hand instead of by a schedule; keep it short" })}
              {target && <> {intl.formatMessage({ id: "web.components.backups.backup_row.target_suffix", defaultMessage: "· {cluster} / {namespace}", description: "Backup row: suffix after the schedule name with the cluster and namespace of the backup's server; {cluster} and {namespace} are names" }, { cluster: target.cluster, namespace: target.namespace })}</>}
            </div>
            {failure && <div className="max-w-xs truncate text-xs text-danger" title={failure}>{failure}</div>}
          </div>
        </div>
      </Table.Cell>
      <Table.Cell>
        {showServer && <span className="font-medium">{backup.spec.serverRef.name}</span>}
      </Table.Cell>
      <Table.Cell>
        <PhaseChip phase={phase} />
      </Table.Cell>
      <Table.Cell>
        {isActiveBackup(backup) ? <div className="w-48"><BackupProgressBar backup={backup} compact /></div> : <span className="text-muted">{intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" })}</span>}
      </Table.Cell>
      <Table.Cell className="font-mono text-sm">{formatSize(backup.status?.size)}</Table.Cell>
      <Table.Cell className="font-mono text-sm">{formatSize(backup.status?.dataAdded)}</Table.Cell>
      <Table.Cell className="text-foreground/70">
        <span title={backup.status?.completionTime}>{formatRelative(backup.status?.completionTime, intl)}</span>
      </Table.Cell>
      <Table.Cell className="text-right">
        <Button
          size="sm"
          variant="outline"
          isDisabled={!restorable || !resourceCan(permissions, "*")}
          onPress={() => onRestore(backup)}
        >
          <RotateCcw className="h-3.5 w-3.5" /> {intl.formatMessage({ id: "web.components.backups.backup_row.restore", defaultMessage: "Restore", description: "Backup row: button in each backup table row that starts restoring that backup; keep it short" })}
        </Button>
      </Table.Cell>
    </Table.Row>
  );
}
