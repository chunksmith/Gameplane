import { useResourceClient, useResourceTarget, resourceKey, useResourcePermissions, resourceCan, type ResourceTarget } from "@/lib/resourceTarget";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Drawer, Button } from "@heroui/react";
import { Archive, CalendarClock, CheckCircle2, Clock, HardDrive, Hash, RotateCcw, Server as ServerIcon, Trash2 } from "lucide-react";

import { cn, formatRelative, formatSize } from "@/lib/utils";
import type { Backup } from "@/types";
import { PhaseChip } from "@/components/ui/PhaseChip";
import { ErrorBanner } from "./ErrorBanner";
import { BackupProgressBar, isActiveBackup } from "./ActiveBackups";
import { SCHEDULE_LABEL } from "@/lib/backupGroups";

interface Props {
  target?: ResourceTarget;
  permissions?: string[];
  name: string | null;
  ns?: string;
  onClose: () => void;
  onRestore: (backup: Backup) => void;
}

export function BackupDetailDrawer({ name, ns, onClose, onRestore, target: explicitTarget, permissions: explicitPermissions }: Props) {
  const resourceTarget = useResourceTarget({ name: name ?? "", namespace: ns }, explicitTarget);
  const resourceClient = useResourceClient(resourceTarget);
  const { Backups } = resourceClient;
  const permissions = useResourcePermissions(explicitPermissions);
  const qc = useQueryClient();
  const open = name !== null;
  const { data: backup, error } = useQuery({
    queryKey: resourceKey(resourceTarget, "backup", name, ns),
    queryFn: ({ signal }) => resourceClient.withSignal(signal).Backups.get(name!, ns),
    enabled: open,
    refetchInterval: 5000,
  });
  const remove = useMutation({
    mutationFn: () => Backups.remove(name!, ns),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["fleet"] });
      void qc.invalidateQueries({ queryKey: resourceKey(resourceTarget, "backups", ns) });
      onClose();
    },
  });

  const restorable =
    backup?.status?.phase === "Succeeded" && Boolean(backup.status.snapshotID);
  const failed = backup?.status?.phase === "Failed";

  return (
    <Drawer
      isOpen={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Drawer.Backdrop>
        <Drawer.Content placement="right" className="me-4">
          <Drawer.Dialog className="flex h-[min(760px,calc(100dvh-2rem))] w-[min(440px,calc(100vw-2rem))] flex-col p-0">
            <Drawer.Header className="flex shrink-0 flex-row items-start gap-3 border-b border-border p-5">
              <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", failed ? "bg-danger/15 text-danger" : "bg-accent/15 text-accent")}>
                <Archive className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <Drawer.Heading className="text-base font-semibold">Backup details</Drawer.Heading>
                <div className="truncate font-mono text-xs text-muted" title={name ?? undefined}>{name}</div>
              </div>
              {backup && <PhaseChip phase={backup.status?.phase} className="shrink-0" />}
            </Drawer.Header>

            <Drawer.Body className="min-h-0 space-y-5 overflow-y-auto p-5 text-sm">
              {error && <ErrorBanner err={error} />}
              {backup && (
                <>
                  {isActiveBackup(backup) && (
                    <div className="rounded-lg border border-border p-3">
                      <BackupProgressBar backup={backup} />
                    </div>
                  )}
                  {backup.status?.message && backup.status.phase !== "Queued" && (
                    <div className={cn("rounded-lg px-3 py-2 text-xs", failed ? "bg-danger/10 text-danger" : "bg-default/40 text-muted")}>
                      {backup.status.message}
                    </div>
                  )}
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-5">
                    <Field icon={<ServerIcon />} label="Server">{backup.spec.serverRef.name}</Field>
                    <Field icon={<CalendarClock />} label="Schedule">{backup.metadata.labels?.[SCHEDULE_LABEL] ?? "manual"}</Field>
                    <Field icon={<HardDrive />} label="Size">
                      <span className="font-mono">{formatSize(backup.status?.size)}</span>
                    </Field>
                    <Field icon={<Hash />} label="Snapshot ID">
                      <span className="break-all font-mono text-xs">{backup.status?.snapshotID ?? "—"}</span>
                    </Field>
                    <Field icon={<Clock />} label="Started">
                      <Timestamp iso={backup.status?.startTime} />
                    </Field>
                    <Field icon={<CheckCircle2 />} label="Completed">
                      <Timestamp iso={backup.status?.completionTime} />
                    </Field>
                  </dl>
                </>
              )}
              {remove.error && <ErrorBanner err={remove.error} />}
            </Drawer.Body>

            <Drawer.Footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border p-4">
              <Button
                variant="danger"
                size="sm"
                isDisabled={!backup || remove.isPending || !resourceCan(permissions, "backups:write")}
                onPress={() => remove.mutate()}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {remove.isPending ? "Deleting…" : "Delete"}
              </Button>
              <Button
                variant="primary"
                size="sm"
                isDisabled={!restorable || !resourceCan(permissions, "backups:restore")}
                onPress={() => backup && onRestore(backup)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Restore
              </Button>
            </Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}

function Field({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="flex items-center gap-1.5 text-xs text-muted [&>svg]:h-3.5 [&>svg]:w-3.5">
        {icon}
        {label}
      </dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

function Timestamp({ iso }: { iso?: string }) {
  return (
    <>
      {formatRelative(iso)}
      {iso && <div className="font-mono text-[11px] text-muted">{iso}</div>}
    </>
  );
}
