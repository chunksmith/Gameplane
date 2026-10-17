import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Switch, Table } from "@heroui/react";
import { CalendarClock, Layers, Pencil, Plus, Trash2, TriangleAlert, Users } from "lucide-react";
import { createResourceClient } from "@/lib/endpoints";
import { targetKey, targetLabel, type Located } from "@/lib/fleet";
import { cn, formatRelative, formatRelativeFuture } from "@/lib/utils";
import { DEFAULT_GROUP, describeCron, effectiveGroups, inGroups, serverGroups } from "@/lib/backupGroups";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBanner } from "./ErrorBanner";
import { GroupScheduleDialog, type Scope } from "./GroupScheduleDialog";
import { ServerGroupsDialog } from "./ServerGroupsDialog";
import type { BackupSchedule, GameServer } from "@/types";
import { useOptionalIntl } from "@/lib/i18n/format";

const can = (permissions: string[], permission: string) => permissions.includes(permission) || permissions.includes("*");
const sameScope = (a: Scope, b: Scope) => a.cluster === b.cluster && a.namespace === b.namespace;

export function groupMembers(schedule: Located<BackupSchedule>, servers: Located<GameServer>[]) {
  return servers.filter((server) => sameScope(server.fleetTarget, schedule.fleetTarget) && inGroups(server.metadata.labels, schedule.spec.groups ?? []));
}

export function BackupGroupsPanel({ schedules, servers }: { schedules: Located<BackupSchedule>[]; servers: Located<GameServer>[] }) {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Located<BackupSchedule> | "new" | null>(null);
  const [deleting, setDeleting] = useState<Located<BackupSchedule> | null>(null);
  const [assigning, setAssigning] = useState<Located<GameServer> | null>(null);
  const groupSchedules = schedules.filter((schedule) => (schedule.spec.groups?.length ?? 0) > 0);
  const knownGroups = [...new Set([DEFAULT_GROUP, ...groupSchedules.flatMap((s) => s.spec.groups ?? []), ...servers.flatMap((s) => serverGroups(s.metadata.labels))])].sort();
  const coveredCount = servers.filter((server) => groupSchedules.some((schedule) => groupMembers(schedule, [server]).length > 0)).length;
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
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">{intl.formatMessage({ id: "web.components.backups.backup_groups_panel.group_schedules", defaultMessage: "Group schedules", description: "Backup groups panel: heading of the section that lists the group backup schedules; keep it short" })}</h2>
            <p className="text-xs text-muted">{intl.formatMessage({ id: "web.components.backups.backup_groups_panel.one_cron_retention_and_concurrency", defaultMessage: "One cron, retention and concurrency limit for every server in the selected groups.", description: "Backup groups panel: explanation under the Group schedules heading, saying one schedule with one cron, retention and concurrency limit covers every server in the selected groups" })}</p>
          </div>
          <Button size="sm" isDisabled={scopes.length === 0} onPress={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> {intl.formatMessage({ id: "web.components.backups.backup_groups_panel.new_group_schedule", defaultMessage: "New group schedule", description: "Backup groups panel: button that opens the form for a new group schedule; keep it short" })}
          </Button>
        </div>
        {(toggle.error || remove.error) && <ErrorBanner err={toggle.error ?? remove.error} />}
        {groupSchedules.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 border border-dashed border-border bg-transparent px-6 py-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
              <Layers className="h-6 w-6" />
            </span>
            <div className="text-sm font-semibold">{intl.formatMessage({ id: "web.components.backups.backup_groups_panel.no_group_schedules_yet", defaultMessage: "No group schedules yet", description: "Backup groups panel: title of the empty state shown when no group schedule exists yet; keep it short" })}</div>
            <p className="max-w-md text-xs text-muted">{intl.formatMessage({ id: "web.components.backups.backup_groups_panel.create_one_for_the_default_group", defaultMessage: "Create one for the <b>{group}</b> group to back up every server that has no group label, like Longhorn recurring jobs.", description: "Backup groups panel: empty-state hint asking the user to create a schedule for the default group, which backs up every server without a group label; {group} is the default group name and <b> wraps it in monospace; Longhorn is a product name and stays as is" }, { group: DEFAULT_GROUP, b: (chunks) => <span className="font-mono">{chunks}</span> })}</p>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {groupSchedules.map((schedule) => {
              const members = groupMembers(schedule, servers);
              const writable = can(schedule.fleetPermissions, "schedules:write");
              return (
                <Card key={targetKey(schedule.fleetTarget)} className={cn("flex flex-col gap-4 border border-border bg-surface p-4 transition-colors hover:border-accent/40", schedule.spec.suspend && "opacity-60")}>
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                      <CalendarClock className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{schedule.metadata.name}</div>
                      <div className="truncate text-xs text-muted">{targetLabel(schedule.fleetTarget)}</div>
                    </div>
                    <Switch
                      isSelected={!schedule.spec.suspend}
                      isDisabled={!writable || toggle.isPending}
                      onChange={(on) => toggle.mutate({ schedule, suspend: !on })}
                      aria-label={intl.formatMessage({ id: "web.components.backups.backup_groups_panel.schedule_active", defaultMessage: "Schedule active", description: "Backup groups panel: accessible name of the switch that turns a group schedule on or off" })}
                    >
                      <Switch.Content>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                      </Switch.Content>
                    </Switch>
                  </div>
                  <div className="space-y-2">
                    <div className="text-sm font-medium">{describeCron(schedule.spec.schedule, intl)}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {(schedule.spec.groups ?? []).map((group) => (
                        <span key={group} className="rounded-full bg-accent/10 px-2 py-0.5 font-mono text-[11px] text-accent">{group}</span>
                      ))}
                    </div>
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-xs">
                    <Stat label={intl.formatMessage({ id: "web.components.backups.backup_groups_panel.retain", defaultMessage: "Retain", description: "Backup groups panel: label above the stat showing how many backups the schedule keeps; keep it short" })} value={schedule.spec.retention?.keepLast ?? intl.formatMessage({ id: "web.components.backups.backup_groups_panel.all", defaultMessage: "all", description: "Backup groups panel: value of the Retain stat when the schedule keeps every backup; keep it short" })} />
                    <Stat label={intl.formatMessage({ id: "web.components.backups.backup_groups_panel.parallel", defaultMessage: "Parallel", description: "Backup groups panel: label above the stat showing how many backups run at the same time; keep it short" })} value={schedule.spec.concurrency ?? "∞"} />
                    <Stat label={intl.formatMessage({ id: "web.components.backups.backup_groups_panel.servers", defaultMessage: "Servers", description: "Backup groups panel: label above the stat showing how many servers the schedule covers; keep it short" })} value={members.length} />
                  </dl>
                  <div className="flex flex-wrap gap-1">
                    {members.slice(0, 6).map((server) => (
                      <span key={server.metadata.name} className="rounded-md border border-border bg-default/30 px-1.5 py-0.5 font-mono text-[11px]">{server.metadata.name}</span>
                    ))}
                    {members.length > 6 && <span className="px-1 text-[11px] text-muted">{intl.formatMessage({ id: "web.components.backups.backup_groups_panel.more_servers_count", defaultMessage: "+{count}", description: "Backup groups panel: badge after the server chips counting the servers hidden beyond the first six; {count} is the number of hidden servers" }, { count: members.length - 6 })}</span>}
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted">
                    <span>
                      {schedule.spec.suspend
                        ? intl.formatMessage({ id: "web.components.backups.backup_groups_panel.paused", defaultMessage: "Paused", description: "Backup groups panel: status text of a paused group schedule; keep it short" })
                        : intl.formatMessage({ id: "web.components.backups.backup_groups_panel.next_time", defaultMessage: "Next {time}", description: "Backup groups panel: when an active group schedule runs next; {time} is a relative time such as in 5 min" }, { time: formatRelativeFuture(schedule.status?.nextScheduleTime, intl) })}
                      {schedule.status?.lastSuccessfulTime && <> {intl.formatMessage({ id: "web.components.backups.backup_groups_panel.last_ok_time", defaultMessage: "· last ok {time}", description: "Backup groups panel: when a group schedule last finished successfully, shown after the next run; {time} is a relative time such as 5 min ago" }, { time: formatRelative(schedule.status.lastSuccessfulTime, intl) })}</>}
                    </span>
                    <span className="flex gap-1">
                      <Button size="sm" variant="ghost" isIconOnly aria-label={intl.formatMessage({ id: "web.components.backups.backup_groups_panel.edit_schedule", defaultMessage: "Edit schedule", description: "Backup groups panel: icon button that opens the editor of a group schedule; read by screen readers" })} isDisabled={!writable} onPress={() => setEditing(schedule)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" isIconOnly aria-label={intl.formatMessage({ id: "web.components.backups.backup_groups_panel.delete_schedule", defaultMessage: "Delete schedule", description: "Backup groups panel: icon button that deletes a group schedule; read by screen readers" })} isDisabled={!writable} onPress={() => setDeleting(schedule)}>
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
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">{intl.formatMessage({ id: "web.components.backups.backup_groups_panel.server_membership", defaultMessage: "Server membership", description: "Backup groups panel: heading of the section that assigns servers to backup groups; keep it short" })}</h2>
            <p className="text-xs text-muted">{intl.formatMessage({ id: "web.components.backups.backup_groups_panel.assign_servers_to_groups_changing", defaultMessage: "Assign servers to groups. Changing groups never restarts a server.", description: "Backup groups panel: explanation under the Server membership heading, saying changing a server's groups never restarts it" })}</p>
          </div>
          {servers.length > 0 && (
            <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", coveredCount < servers.length ? "bg-warning-soft text-warning-soft-foreground" : "bg-success-soft text-success-soft-foreground")}>
              {intl.formatMessage({ id: "web.components.backups.backup_groups_panel.coveredcount_of_length_covered", defaultMessage: "{coveredCount} of {length} covered", description: "Backup groups panel: badge in the Server membership heading counting servers backed up by a schedule; {coveredCount} is the covered count and {length} the total number of servers" }, { coveredCount: coveredCount, length: servers.length })}
            </span>
          )}
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <Table.Root>
            <Table.ScrollContainer>
              <Table.Content aria-label={intl.formatMessage({ id: "web.components.backups.backup_groups_panel.server_backup_groups", defaultMessage: "Server backup groups", description: "Backup groups panel: accessible name of the server table that lists each server's backup groups" })}>
                <Table.Header>
                  <Table.Column key="server" isRowHeader>{intl.formatMessage({ id: "web.components.backups.backup_groups_panel.server", defaultMessage: "Server", description: "Backup groups panel: column header of the server name column in the server table; keep it short" })}</Table.Column>
                  <Table.Column key="groups">{intl.formatMessage({ id: "web.components.backups.backup_groups_panel.groups", defaultMessage: "Groups", description: "Backup groups panel: column header of the groups column in the server table, also the label of the button that opens the server's group editor; keep it short" })}</Table.Column>
                  <Table.Column key="covered">{intl.formatMessage({ id: "web.components.backups.backup_groups_panel.covered_by", defaultMessage: "Covered by", description: "Backup groups panel: column header of the column listing the schedules that back up a server; keep it short" })}</Table.Column>
                  <Table.Column key="actions" className="text-end" />
                </Table.Header>
                <Table.Body renderEmptyState={() => <>{intl.formatMessage({ id: "web.components.backups.backup_groups_panel.no_servers", defaultMessage: "No servers.", description: "Backup groups panel: text in the server table when there are no servers" })}</>}>
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
                                {group}{explicit.length ? null : <> {intl.formatMessage({ id: "web.components.backups.backup_groups_panel.implicit", defaultMessage: "· implicit", description: "Backup groups panel: suffix on a group chip of a server with no group label of its own, so the group is implied; keep it short" })}</>}
                              </span>
                            ))}
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          {covering.length === 0 ? (
                            <span className="inline-flex items-center gap-1.5 text-xs text-warning">
                              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />{intl.formatMessage({ id: "web.components.backups.backup_groups_panel.not_backed_up_by_any_group", defaultMessage: "Not backed up by any group", description: "Backup groups panel: warning in the Covered by column when no group schedule backs up the server; keep it short" })}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                              <CalendarClock className="h-3.5 w-3.5 shrink-0" />
                              {covering.map((s) => s.metadata.name).join(", ")}
                            </span>
                          )}
                        </Table.Cell>
                        <Table.Cell className="text-end">
                          <Button size="sm" variant="outline" isDisabled={!can(server.fleetPermissions, "servers:write")} onPress={() => setAssigning(server)}>
                            <Users className="h-3.5 w-3.5" /> {intl.formatMessage({ id: "web.components.backups.backup_groups_panel.groups", defaultMessage: "Groups", description: "Backup groups panel: column header of the groups column in the server table, also the label of the button that opens the server's group editor; keep it short" })}
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
        title={intl.formatMessage({ id: "web.components.backups.backup_groups_panel.delete_group_schedule", defaultMessage: "Delete group schedule?", description: "Backup groups panel: title of the dialog that confirms deleting a group schedule" })}
        description={<p>{intl.formatMessage({ id: "web.components.backups.backup_groups_panel.existing_backups_stay_servers_in_these", defaultMessage: "Existing backups stay; servers in these groups stop getting new snapshots from this schedule.", description: "Backup groups panel: body of the delete confirmation, saying existing backups are kept but the schedule stops making new ones" })}</p>}
        confirmPhrase={deleting?.metadata.name}
        confirmLabel={intl.formatMessage({ id: "web.components.backups.backup_groups_panel.delete", defaultMessage: "Delete", description: "Backup groups panel: confirm button of the delete group schedule dialog; keep it short" })}
        destructive
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-default/40 px-2.5 py-2">
      <dt className="text-[10px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className="font-mono text-sm text-foreground">{value}</dd>
    </div>
  );
}
