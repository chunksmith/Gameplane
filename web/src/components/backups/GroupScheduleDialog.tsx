import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Checkbox,
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
import { FREQUENCIES, GROUP_NAME, cronPreset, describeCron, presetCron } from "@/lib/backupGroups";
import { GroupPicker } from "./GroupPicker";
import { ErrorBanner } from "./ErrorBanner";
import type { BackupSchedule } from "@/types";

export interface Scope {
  cluster: string;
  namespace: string;
}

const scopeKey = (scope: Scope) => `${scope.cluster}/${scope.namespace}`;

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
  const [quiesce, setQuiesce] = useState(schedule?.spec.quiesce ?? true);
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
        quiesce,
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
              <ModalHeading>{schedule ? `Edit ${schedule.metadata.name}` : "New backup group schedule"}</ModalHeading>
            </ModalHeader>
            <ModalBody className="gap-5">
              <p className="text-sm text-muted">
                Backs up every server in the selected groups. Servers join a group with the
                <span className="mx-1 font-mono text-xs">backup-group.gameplane.local/&lt;group&gt;</span>
                label; servers without any group label belong to <span className="font-mono text-xs">default</span>.
              </p>

              {!schedule && (
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="group-schedule-name" className="text-xs">Name</Label>
                    <Input id="group-schedule-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="nightly" className="h-9 font-mono" />
                  </div>
                  {scopes.length > 1 && (
                    <Select value={scope ? scopeKey(scope) : ""} onChange={(v) => { setScope(scopes.find((s) => scopeKey(s) === v)); setRepo(""); }}>
                      <Label className="text-xs">Location</Label>
                      <Select.Trigger className="h-9">
                        <Select.Value />
                        <Select.Indicator className="ml-auto h-4 w-4" />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox aria-label="Location">
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
                <Label className="text-xs">Groups</Label>
                <GroupPicker known={knownGroups} value={groups} onChange={setGroups} />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <Select value={frequency} onChange={(v) => setFrequency(String(v))}>
                  <Label className="text-xs">Frequency</Label>
                  <Select.Trigger className="h-9">
                    <Select.Value />
                    <Select.Indicator className="ml-auto h-4 w-4" />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox aria-label="Frequency">
                      {FREQUENCIES.map((every) => (
                        <ListBoxItem key={every} id={String(every)}>
                          {every === 24 ? "Every day" : every === 1 ? "Every hour" : `Every ${every} hours`}
                        </ListBoxItem>
                      ))}
                      <ListBoxItem id="custom">Custom cron (UTC)</ListBoxItem>
                    </ListBox>
                  </Select.Popover>
                </Select>
                {frequency === "custom" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="group-schedule-cron" className="text-xs">Cron (UTC)</Label>
                    <Input id="group-schedule-cron" value={cron} onChange={(e) => setCron(e.target.value)} className="h-9 font-mono" />
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor="group-schedule-time" className="text-xs">{frequency === "1" ? "Minute (local)" : "Starting at (local time)"}</Label>
                    <Input id="group-schedule-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-9 font-mono" />
                  </div>
                )}
              </div>
              <div className="-mt-2 rounded-md bg-default/40 px-3 py-2 text-xs text-muted">
                {describeCron(expression)} · <span className="font-mono">{expression}</span>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="group-schedule-retain" className="text-xs">Retain (per server)</Label>
                  <Input id="group-schedule-retain" type="number" min={1} value={String(retain)} onChange={(e) => setRetain(Number(e.target.value))} className="h-9 font-mono" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="group-schedule-concurrency" className="text-xs">Concurrency</Label>
                  <Input id="group-schedule-concurrency" type="number" min={1} value={String(concurrency)} onChange={(e) => setConcurrency(Number(e.target.value))} className="h-9 font-mono" />
                </div>
                <Select value={repo} onChange={(v) => setRepo(String(v))}>
                  <Label className="text-xs">Destination</Label>
                  <Select.Trigger className="h-9">
                    <Select.Value />
                    <Select.Indicator className="ml-auto h-4 w-4" />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox aria-label="Destination">
                      {destinations.map((d) => (
                        <ListBoxItem key={d.name} id={d.name}>{d.name}</ListBoxItem>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>

              <Checkbox isSelected={quiesce} onChange={setQuiesce} className="flex-row items-center gap-2">
                <Checkbox.Control className="size-4">
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <Checkbox.Content>
                  <span className="text-sm">Flush and pause world saves during the backup</span>
                </Checkbox.Content>
              </Checkbox>

              {save.error && <ErrorBanner err={save.error} />}
            </ModalBody>
            <ModalFooter>
              <Button variant="ghost" onPress={onClose} isDisabled={save.isPending}>Cancel</Button>
              <Button onPress={() => save.mutate()} isDisabled={!valid || save.isPending}>
                {save.isPending ? "Saving…" : schedule ? "Save changes" : "Create schedule"}
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}
