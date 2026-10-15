import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Switch, Table } from "@heroui/react";
import { CalendarClock, Layers, Pencil, Plus, Trash2, Users } from "lucide-react";
import { createResourceClient } from "@/lib/endpoints";
import { targetKey, targetLabel, type Located } from "@/lib/fleet";
import { formatRelative, formatRelativeFuture } from "@/lib/utils";
import { DEFAULT_GROUP, describeCron, effectiveGroups, inGroups, serverGroups } from "@/lib/backupGroups";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBanner } from "./ErrorBanner";
import { GroupScheduleDialog, type Scope } from "./GroupScheduleDialog";
import { ServerGroupsDialog } from "./ServerGroupsDialog";
import type { BackupSchedule, GameServer } from "@/types";

const can = (permissions: string[], permission: string) => permissions.includes(permission) || permissions.includes("*");
const sameScope = (a: Scope, b: Scope) => a.cluster === b.cluster && a.namespace === b.namespace;

export function groupMembers(schedule: Located<BackupSchedule>, servers: Located<GameServer>[]) {
  return servers.filter((server) => sameScope(server.fleetTarget, schedule.fleetTarget) && inGroups(server.metadata.labels, schedule.spec.groups ?? []));
}

export function BackupGroupsPanel({ schedules, servers }: { schedules: Located<BackupSchedule>[]; servers: Located<GameServer>[] }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Located<BackupSchedule> | "new" | null>(null);
  const [deleting, setDeleting] = useState<Located<BackupSchedule> | null>(null);
  const [assigning, setAssigning] = useState<Located<GameServer> | null>(null);
  const groupSchedules = schedules.filter((schedule) => (schedule.spec.groups?.length ?? 0) > 0);
  const knownGroups = [...new Set([DEFAULT_GROUP, ...groupSchedules.flatMap((s) => s.spec.groups ?? []), ...servers.flatMap((s) => serverGroups(s.metadata.labels))])].sort();
  const scopes = [...new Map(servers.filter((s) => can(s.fleetPermissions, "schedules:write")).map((s) => [`${s.fleetTarget.cluster}/${s.fleetTarget.namespace}`, { cluster: s.fleetTarget.cluster, namespace: s.fleetTarget.namespace }])).values()];

  const toggle = useMutation({
    mutationFn: ({ schedule, suspend }: { schedule: Located<BackupSchedule>; suspend: boolean }) =>
      createResourceClient(schedule.fleetTarget).Schedules.patchSpec(schedule.metadata.name, { suspend }, schedule.fleetTarget.namespace),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fleet", "schedules"] }),
  });
  const remove = useMutation({
    mutationFn: (schedule: Located<BackupSchedule>) => createResourceClient(schedule.fleetTarget).Schedules.remove(schedule.metadata.name, schedule.fleetTarget.namespace),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["fleet", "schedules"] });
      setDeleting(null);
    },
  });

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Group schedules</h2>
            <p className="text-xs text-muted">One cron, retention and concurrency limit for every server in the selected groups.</p>
          </div>
          <Button size="sm" isDisabled={scopes.length === 0} onPress={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> New group schedule
          </Button>
        </div>
        {(toggle.error || remove.error) && <ErrorBanner err={toggle.error ?? remove.error} />}
        {groupSchedules.length === 0 ? (
          <Card className="flex flex-col items-center gap-2 border border-dashed border-border bg-transparent p-8 text-center">
            <Layers className="h-6 w-6 text-muted" />
            <div className="text-sm font-medium">No group schedules yet</div>
            <p className="max-w-md text-xs text-muted">Create one for the <span className="font-mono">default</span> group to back up every server that has no group label, like Longhorn recurring jobs.</p>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {groupSchedules.map((schedule) => {
              const members = groupMembers(schedule, servers);
              const writable = can(schedule.fleetPermissions, "schedules:write");
              return (
                <Card key={targetKey(schedule.fleetTarget)} className={`border border-border bg-surface p-4 ${schedule.spec.suspend ? "opacity-60" : ""}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{schedule.metadata.name}</div>
                      <div className="text-xs text-muted">{targetLabel(schedule.fleetTarget)}</div>
                    </div>
                    <Switch
                      isSelected={!schedule.spec.suspend}
                      isDisabled={!writable || toggle.isPending}
                      onChange={(on) => toggle.mutate({ schedule, suspend: !on })}
                      aria-label="Schedule active"
                    >
                      <Switch.Content>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                      </Switch.Content>
                    </Switch>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-3">
                    {(schedule.spec.groups ?? []).map((group) => (
                      <span key={group} className="rounded-full bg-accent/10 px-2 py-0.5 font-mono text-[11px] text-accent">{group}</span>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 pt-3 text-sm">
                    <CalendarClock className="h-4 w-4 text-muted" />
                    {describeCron(schedule.spec.schedule)}
                  </div>
                  <dl className="grid grid-cols-3 gap-2 pt-3 text-xs">
                    <Stat label="Retain" value={schedule.spec.retention?.keepLast ?? "all"} />
                    <Stat label="Parallel" value={schedule.spec.concurrency ?? "∞"} />
                    <Stat label="Servers" value={members.length} />
                  </dl>
                  <div className="flex flex-wrap gap-1 pt-3">
                    {members.slice(0, 6).map((server) => (
                      <span key={server.metadata.name} className="rounded border border-border px-1.5 py-0.5 text-[11px]">{server.metadata.name}</span>
                    ))}
                    {members.length > 6 && <span className="px-1 text-[11px] text-muted">+{members.length - 6}</span>}
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-border pt-3 mt-3 text-xs text-muted">
                    <span>
                      {schedule.spec.suspend ? "Paused" : `Next ${formatRelativeFuture(schedule.status?.nextScheduleTime)}`}
                      {schedule.status?.lastSuccessfulTime && ` · last ok ${formatRelative(schedule.status.lastSuccessfulTime)}`}
                    </span>
                    <span className="flex gap-1">
                      <Button size="sm" variant="ghost" isIconOnly aria-label="Edit schedule" isDisabled={!writable} onPress={() => setEditing(schedule)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" isIconOnly aria-label="Delete schedule" isDisabled={!writable} onPress={() => setDeleting(schedule)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Server membership</h2>
          <p className="text-xs text-muted">Assign servers to groups. Changing groups never restarts a server.</p>
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <Table.Root>
            <Table.ScrollContainer>
              <Table.Content aria-label="Server backup groups">
                <Table.Header>
                  <Table.Column key="server" isRowHeader>Server</Table.Column>
                  <Table.Column key="groups">Groups</Table.Column>
                  <Table.Column key="covered">Covered by</Table.Column>
                  <Table.Column key="actions" className="text-end" />
                </Table.Header>
                <Table.Body renderEmptyState={() => <>No servers.</>}>
                  {servers.map((server) => {
                    const explicit = serverGroups(server.metadata.labels);
                    const covering = groupSchedules.filter((schedule) => groupMembers(schedule, [server]).length > 0);
                    return (
                      <Table.Row key={targetKey(server.fleetTarget)}>
                        <Table.Cell>
                          <div className="font-medium">{server.metadata.name}</div>
                          <div className="text-xs text-muted">{targetLabel(server.fleetTarget)}</div>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex flex-wrap gap-1">
                            {effectiveGroups(server.metadata.labels).map((group) => (
                              <span key={group} className={`rounded-full px-2 py-0.5 font-mono text-[11px] ${explicit.length ? "bg-accent/10 text-accent" : "border border-dashed border-border text-muted"}`}>
                                {group}{explicit.length ? "" : " · implicit"}
                              </span>
                            ))}
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          {covering.length === 0 ? (
                            <span className="text-xs text-warning">Not backed up by any group</span>
                          ) : (
                            <span className="text-xs text-muted">{covering.map((s) => s.metadata.name).join(", ")}</span>
                          )}
                        </Table.Cell>
                        <Table.Cell className="text-end">
                          <Button size="sm" variant="outline" isDisabled={!can(server.fleetPermissions, "servers:write")} onPress={() => setAssigning(server)}>
                            <Users className="h-3.5 w-3.5" /> Groups
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table.Root>
        </div>
      </section>

      {editing && (
        <GroupScheduleDialog
          schedule={editing === "new" ? undefined : editing}
          scopes={scopes}
          knownGroups={knownGroups}
          onClose={() => setEditing(null)}
        />
      )}
      {assigning && <ServerGroupsDialog server={assigning} knownGroups={knownGroups} onClose={() => setAssigning(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title="Delete group schedule?"
        description={<p>Existing backups stay; servers in these groups stop getting new snapshots from this schedule.</p>}
        confirmPhrase={deleting?.metadata.name}
        confirmLabel="Delete"
        destructive
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md bg-default/40 px-2 py-1.5">
      <dt className="text-[10px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className="font-mono text-sm text-foreground">{value}</dd>
    </div>
  );
}
