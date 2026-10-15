import { useResourcePermissions, resourceCan, type ResourceTarget } from "@/lib/resourceTarget";
import { Button, Table } from "@heroui/react";
import { formatRelative, formatSize } from "@/lib/utils";
import type { Backup } from "@/types";
import { PhaseChip } from "@/components/ui/PhaseChip";
import { SCHEDULE_LABEL } from "@/lib/backupGroups";
import { BackupProgressBar, isActiveBackup } from "./ActiveBackups";

interface Props {
  target?: ResourceTarget;
  permissions?: string[];
  backup: Backup;
  showServer: boolean;
  onSelect: (b: Backup) => void;
  onRestore: (b: Backup) => void;
}

export function BackupRow({ backup, showServer, onSelect, onRestore, target, permissions: explicitPermissions }: Props) {
  const permissions = useResourcePermissions(explicitPermissions);
  const restorable =
    backup.status?.phase === "Succeeded" && Boolean(backup.status.snapshotID);
  return (
    <Table.Row
      className="cursor-pointer"
      onAction={() => onSelect(backup)}
    >
      <Table.Cell className="font-mono text-xs">
        {backup.metadata.name}
        <div className="text-muted">
          {backup.metadata.labels?.[SCHEDULE_LABEL] ?? "manual"}
          {target && ` · ${target.cluster} / ${target.namespace}`}
        </div>
      </Table.Cell>
      <Table.Cell>
        {showServer && backup.spec.serverRef.name}
      </Table.Cell>
      <Table.Cell>
        <PhaseChip phase={backup.status?.phase} />
      </Table.Cell>
      <Table.Cell>
        {isActiveBackup(backup) ? <div className="w-48"><BackupProgressBar backup={backup} compact /></div> : "—"}
      </Table.Cell>
      <Table.Cell className="font-mono">{formatSize(backup.status?.size)}</Table.Cell>
      <Table.Cell>
        {formatRelative(backup.status?.completionTime)}
      </Table.Cell>
      <Table.Cell className="text-right">
        <Button
          size="sm"
          variant="outline"
          isDisabled={!restorable || !resourceCan(permissions, "backups:restore")}
          onPress={() => onRestore(backup)}
        >
          Restore
        </Button>
      </Table.Cell>
    </Table.Row>
  );
}
