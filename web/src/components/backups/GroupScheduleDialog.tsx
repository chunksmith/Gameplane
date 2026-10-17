import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContainer,
  ModalDialog,
  ModalFooter,
  ModalHeader,
  ModalHeading,
  Select,
} from "@heroui/react";
import { createResourceClient } from "@/lib/endpoints";
import { useBackupDestinations } from "@/lib/destinations";
import { targetLabel, type Located } from "@/lib/fleet";
import { DEFAULT_GROUP, FREQUENCIES, GROUP_LABEL_PREFIX, GROUP_NAME, cronPreset, describeCron, presetCron } from "@/lib/backupGroups";
import { GroupPicker } from "./GroupPicker";
import { ErrorBanner } from "./ErrorBanner";
import type { BackupSchedule } from "@/types";
import { useOptionalIntl } from "@/lib/i18n/format";

export interface Scope {
  cluster: string;
  namespace: string;
}

const scopeKey = (scope: Scope) => `${scope.cluster}/${scope.namespace}`;
const GROUP_LABEL_EXAMPLE = `${GROUP_LABEL_PREFIX}<group>`;

export function GroupScheduleDialog({
  schedule,
  scopes,
  knownGroups,
  onClose,
}: {
  schedule?: Located<BackupSchedule>;
  scopes: Scope[];
  knownGroups: string[];
  onClose: () => void;
}) {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const initialPreset = schedule ? cronPreset(schedule.spec.schedule) : { every: 24, time: "04:00" };
  const [scope, setScope] = useState<Scope | undefined>(schedule?.fleetTarget ?? scopes[0]);
  const [name, setName] = useState(schedule?.metadata.name ?? "");
  const [groups, setGroups] = useState<string[]>(schedule?.spec.groups ?? ["default"]);
  const [frequency, setFrequency] = useState(initialPreset ? String(initialPreset.every) : "custom");
  const [time, setTime] = useState(initialPreset?.time ?? "04:00");
  const [cron, setCron] = useState(schedule?.spec.schedule ?? "0 1 * * *");
  const [retain, setRetain] = useState(schedule?.spec.retention?.keepLast ?? 7);
  const [concurrency, setConcurrency] = useState(schedule?.spec.concurrency ?? 1);
  const [repo, setRepo] = useState(schedule?.spec.repoRef?.name ?? "");
  const { data: destinations = [] } = useBackupDestinations(scope);
  if (!repo && destinations.length > 0) setRepo(destinations[0].name);

  const expression = frequency === "custom" ? cron.trim() : presetCron({ every: Number(frequency), time });
  const valid =
    !!scope && GROUP_NAME.test(name) && groups.length > 0 && !!repo && retain >= 1 && concurrency >= 1 &&
    /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(expression);

  const save = useMutation({
    mutationFn: () => {
      const client = createResourceClient(scope!).Schedules;
      const spec = {
        groups,
        concurrency,
        quiesce: false,
        schedule: expression,
        repoRef: { name: repo, key: "repo" },
        retention: { keepLast: retain },
      };
      return schedule
        ? client.patchSpec(schedule.metadata.name, spec, scope!.namespace)
        : client.create({ name, strategy: "restic-snapshot", ...spec }, scope!.namespace);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["fleet", "schedules"] });
      onClose();
    },
  });

  return (
    <Modal isOpen onOpenChange={(open) => { if (!open) onClose(); }}>
      <ModalBackdrop isDismissable={!save.isPending}>
        <ModalContainer>
          <ModalDialog className="max-w-xl">
            <ModalHeader>
              <ModalHeading>{schedule
                ? intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.edit_name", defaultMessage: "Edit {name}", description: "Group schedule dialog: heading of the dialog when editing an existing schedule; {name} is the schedule name" }, { name: schedule.metadata.name })
                : intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.new_backup_group_schedule", defaultMessage: "New backup group schedule", description: "Group schedule dialog: heading of the dialog when creating a new group schedule" })}</ModalHeading>
            </ModalHeader>
            <ModalBody className="gap-5">
              <p className="text-sm text-muted">{intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.backs_up_every_server_in_the_selected", defaultMessage: "Backs up every server in the selected groups. Servers join a group with the", description: "Group schedule dialog: first sentence under the heading, saying the schedule backs up every server in the selected groups and how servers join a group; the label name follows in its own element" })}<span className="mx-1 font-mono text-xs">{GROUP_LABEL_EXAMPLE}</span>{intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.label_servers_without_any_group_label", defaultMessage: "label; servers without any group label belong to <b>{group}</b>.", description: "Group schedule dialog: end of the sentence under the heading, saying servers without any group label belong to the default group; {group} is the default group name and <b> wraps it in monospace" }, { group: DEFAULT_GROUP, b: (chunks) => <span className="font-mono text-xs">{chunks}</span> })}
              </p>

              {!schedule && (
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="group-schedule-name" className="text-xs">{intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.name", defaultMessage: "Name", description: "Group schedule dialog: label of the name input of a new group schedule; keep it short" })}</Label>
                    <Input id="group-schedule-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder={intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.nightly", defaultMessage: "nightly", description: "Group schedule dialog: example schedule name shown as the placeholder of the name input; keep it as a lowercase slug" })} className="h-9 font-mono" />
                  </div>
                  {scopes.length > 1 && (
                    <Select value={scope ? scopeKey(scope) : ""} onChange={(v) => { setScope(scopes.find((s) => scopeKey(s) === v)); setRepo(""); }}>
                      <Label className="text-xs">{intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.location", defaultMessage: "Location", description: "Group schedule dialog: label of the location picker that chooses the cluster and namespace of the new schedule; keep it short" })}</Label>
                      <Select.Trigger className="h-9">
                        <Select.Value />
                        <Select.Indicator className="ml-auto h-4 w-4" />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox aria-label={intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.location", defaultMessage: "Location", description: "Group schedule dialog: label of the location picker that chooses the cluster and namespace of the new schedule; keep it short" })}>
                          {scopes.map((s) => (
                            <ListBoxItem key={scopeKey(s)} id={scopeKey(s)} textValue={targetLabel(s)}>{targetLabel(s)}</ListBoxItem>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <Label className="text-xs">{intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.groups", defaultMessage: "Groups", description: "Group schedule dialog: label above the picker of the groups the schedule backs up; keep it short" })}</Label>
                <GroupPicker known={knownGroups} value={groups} onChange={setGroups} />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <Select value={frequency} onChange={(v) => setFrequency(String(v))}>
                  <Label className="text-xs">{intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.frequency", defaultMessage: "Frequency", description: "Group schedule dialog: label of the frequency picker that sets how often the schedule runs; keep it short" })}</Label>
                  <Select.Trigger className="h-9">
                    <Select.Value />
                    <Select.Indicator className="ml-auto h-4 w-4" />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox aria-label={intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.frequency", defaultMessage: "Frequency", description: "Group schedule dialog: label of the frequency picker that sets how often the schedule runs; keep it short" })}>
                      {FREQUENCIES.map((every) => (
                        <ListBoxItem key={every} id={String(every)}>
                          {every === 24
                            ? intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.every_day", defaultMessage: "Every day", description: "Group schedule dialog: frequency option that runs the schedule once a day; keep it short" })
                            : every === 1
                              ? intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.every_hour", defaultMessage: "Every hour", description: "Group schedule dialog: frequency option that runs the schedule once an hour; keep it short" })
                              : intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.every_hours", defaultMessage: "Every {count, plural, one {# hour} other {# hours}}", description: "Group schedule dialog: frequency option that runs the schedule every few hours; {count} is the number of hours between runs" }, { count: every })}
                        </ListBoxItem>
                      ))}
                      <ListBoxItem id="custom">{intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.custom_cron_utc", defaultMessage: "Custom cron (UTC)", description: "Group schedule dialog: frequency option for typing a raw cron expression in UTC; keep it short" })}</ListBoxItem>
                    </ListBox>
                  </Select.Popover>
                </Select>
                {frequency === "custom" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="group-schedule-cron" className="text-xs">{intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.cron_utc", defaultMessage: "Cron (UTC)", description: "Group schedule dialog: label of the cron expression input shown for the custom frequency; keep it short" })}</Label>
                    <Input id="group-schedule-cron" value={cron} onChange={(e) => setCron(e.target.value)} className="h-9 font-mono" />
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor="group-schedule-time" className="text-xs">{frequency === "1"
                      ? intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.minute_local", defaultMessage: "Minute (local)", description: "Group schedule dialog: label of the time input for an hourly schedule, asking for the minute past the hour in local time; keep it short" })
                      : intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.starting_at_local_time", defaultMessage: "Starting at (local time)", description: "Group schedule dialog: label of the time input for a schedule that runs every few hours, asking for the first run in local time; keep it short" })}</Label>
                    <Input id="group-schedule-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-9 font-mono" />
                  </div>
                )}
              </div>
              <div className="-mt-2 rounded-md bg-default/40 px-3 py-2 text-xs text-muted">
                {describeCron(expression, intl)} {intl.formatMessage({ id: "web.common.separator_dot", defaultMessage: "·", description: "Visual separator between two items" })} <span className="font-mono">{expression}</span>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="group-schedule-retain" className="text-xs">{intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.retain_per_server", defaultMessage: "Retain (per server)", description: "Group schedule dialog: label of the input for how many backups to keep per server; keep it short" })}</Label>
                  <Input id="group-schedule-retain" type="number" min={1} value={String(retain)} onChange={(e) => setRetain(Number(e.target.value))} className="h-9 font-mono" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="group-schedule-concurrency" className="text-xs">{intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.concurrency", defaultMessage: "Concurrency", description: "Group schedule dialog: label of the input for how many servers are backed up at the same time; keep it short" })}</Label>
                  <Input id="group-schedule-concurrency" type="number" min={1} value={String(concurrency)} onChange={(e) => setConcurrency(Number(e.target.value))} className="h-9 font-mono" />
                </div>
                <Select value={repo} onChange={(v) => setRepo(String(v))}>
                  <Label className="text-xs">{intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.destination", defaultMessage: "Destination", description: "Group schedule dialog: label of the picker for the backup destination the schedule writes to; keep it short" })}</Label>
                  <Select.Trigger className="h-9">
                    <Select.Value />
                    <Select.Indicator className="ml-auto h-4 w-4" />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox aria-label={intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.destination", defaultMessage: "Destination", description: "Group schedule dialog: label of the picker for the backup destination the schedule writes to; keep it short" })}>
                      {destinations.map((d) => (
                        <ListBoxItem key={d.name} id={d.name}>{d.name}</ListBoxItem>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>

              {save.error && <ErrorBanner err={save.error} />}
            </ModalBody>
            <ModalFooter>
              <Button variant="ghost" onPress={onClose} isDisabled={save.isPending}>{intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.cancel", defaultMessage: "Cancel", description: "Group schedule dialog: button that closes the dialog without saving; keep it short" })}</Button>
              <Button onPress={() => save.mutate()} isDisabled={!valid || save.isPending}>
                {save.isPending
                  ? intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.saving", defaultMessage: "Saving…", description: "Group schedule dialog: label of the submit button while the schedule is being saved; keep it short" })
                  : schedule
                    ? intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.save_changes", defaultMessage: "Save changes", description: "Group schedule dialog: submit button that saves changes to an existing schedule; keep it short" })
                    : intl.formatMessage({ id: "web.components.backups.group_schedule_dialog.create_schedule", defaultMessage: "Create schedule", description: "Group schedule dialog: submit button that creates a new group schedule; keep it short" })}
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}
