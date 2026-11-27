import { useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Modal, ModalBackdrop, ModalBody, ModalContainer, ModalDialog, ModalFooter, ModalHeader, ModalHeading, Switch } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { Check, Rocket, ShieldCheck, Sparkles, X } from "lucide-react";
import { ServerPicker } from "@/components/ServerPicker";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { api } from "@/lib/api";
import type { FileEntry } from "@/lib/endpoints";
import { targetKey, useFleetServers, type FleetItem } from "@/lib/fleet";
import { useFormat, useOptionalIntl } from "@/lib/i18n/format";
import { Builds, buildsKey, gitErrorText } from "@/lib/repositories";
import { cn } from "@/lib/utils";
import type { Build, BuildArtifact, DeployResult, GameServer, Repository } from "@/types";
import { joinDot, sizeLabel } from "./buildUi";

const M: Record<string, MessageDescriptor> = defineMessages({
  title: { id: "web.repositories.deploy.title", defaultMessage: "Deploy {artifact}", description: "Deploy dialog: heading; {artifact} is the jar file name" },
  intro: { id: "web.repositories.deploy.intro", defaultMessage: "Copy a jar from this build into the servers you pick. Only servers you can edit are listed.", description: "Deploy dialog: text under the heading explaining what the deploy does" },
  manual: { id: "web.repositories.deploy.manual", defaultMessage: "Manual", description: "Deploy dialog: segment that deploys by picking the jar and servers yourself; keep it short" },
  with_assistant: { id: "web.repositories.deploy.with_assistant", defaultMessage: "With Assistant", description: "Deploy dialog: segment that asks the assistant to deploy; keep it short" },
  artifact: { id: "web.repositories.deploy.artifact", defaultMessage: "Artifact", description: "Deploy dialog: label of the field that picks the jar to deploy" },
  artifact_hint: { id: "web.repositories.deploy.artifact_hint", defaultMessage: "Jars this build produced. Sources, javadoc and unshaded originals are hidden.", description: "Deploy dialog: hint under the artifact field" },
  servers: { id: "web.repositories.deploy.servers", defaultMessage: "Servers", description: "Deploy dialog: label of the server picker" },
  selected: { id: "web.repositories.deploy.selected", defaultMessage: "{count} selected", description: "Deploy dialog: number of servers picked; {count} is the number" },
  servers_hint: { id: "web.repositories.deploy.servers_hint", defaultMessage: "Servers on other clusters are listed too. Stopped servers get the file through their files pod.", description: "Deploy dialog: hint under the server picker" },
  runtime_template: { id: "web.repositories.deploy.runtime_template", defaultMessage: "{template}", description: "Deploy dialog: template name shown in a server row; {template} is the template name" },
  has_jar: { id: "web.repositories.deploy.has_jar", defaultMessage: "has {file}", description: "Deploy dialog: server row note naming an older jar of the same plugin; {file} is the file name" },
  folder: { id: "web.repositories.deploy.folder", defaultMessage: "Folder", description: "Deploy dialog: label of the folder field, relative to the server's data folder" },
  folder_hint: { id: "web.repositories.deploy.folder_hint", defaultMessage: "Relative to each server's data folder.", description: "Deploy dialog: hint under the folder field" },
  file_name: { id: "web.repositories.deploy.file_name", defaultMessage: "File name", description: "Deploy dialog: label of the field with the name the jar gets on the servers" },
  file_name_hint: { id: "web.repositories.deploy.file_name_hint", defaultMessage: "An existing file with this name is replaced.", description: "Deploy dialog: hint under the file name field" },
  remove: { id: "web.repositories.deploy.remove", defaultMessage: "Remove old jars", description: "Deploy dialog: label of the chips that pick old jars to delete" },
  remove_hint: { id: "web.repositories.deploy.remove_hint", defaultMessage: "Suggested from {prefix}-*.jar files already in the folder on the selected servers.", description: "Deploy dialog: hint under the remove chips; {prefix} is the plugin name" },
  restart: { id: "web.repositories.deploy.restart", defaultMessage: "Restart after deploy", description: "Deploy dialog: label of the switch that restarts the servers after the deploy" },
  restart_hint: { id: "web.repositories.deploy.restart_hint", defaultMessage: "Off: the plugin loads on each server's next restart.", description: "Deploy dialog: hint under the restart switch" },
  permissions_title: { id: "web.repositories.deploy.permissions_title", defaultMessage: "Runs with your permissions", description: "Deploy dialog: title of the note about permissions; keep it short" },
  permissions_body: { id: "web.repositories.deploy.permissions_body", defaultMessage: "Each server is written with your own access. If one fails, the others still deploy and the result shows which one failed. Every deploy goes to the audit log.", description: "Deploy dialog: body of the note about permissions" },
  deploy_count: { id: "web.repositories.deploy.deploy_count", defaultMessage: "Deploy to {count, plural, one {# server} other {# servers}}", description: "Deploy dialog: primary button; {count} is the number of servers picked" },
  done: { id: "web.repositories.deploy.done", defaultMessage: "Done", description: "Deploy dialog: button that closes the dialog after a deploy; keep it short" },
  cancel: { id: "web.repositories.deploy.cancel", defaultMessage: "Cancel", description: "Deploy dialog: button that closes the dialog without deploying; keep it short" },
  result: { id: "web.repositories.deploy.result", defaultMessage: "{ok} / {total} written", description: "Deploy dialog: result summary; {ok} is the servers written and {total} the servers targeted" },
  result_failed: { id: "web.repositories.deploy.result_failed", defaultMessage: "Failed: {error}", description: "Deploy dialog: result line for a server that could not be written; {error} is the reason" },
  assistant_intro: { id: "web.repositories.deploy.assistant_intro", defaultMessage: "Tell the assistant where to deploy this jar. It opens a conversation about this build.", description: "Deploy dialog: text in the assistant mode explaining what the button does" },
  instruction: { id: "web.repositories.deploy.instruction", defaultMessage: "Instruction", description: "Deploy dialog: label of the text field with the instruction for the assistant" },
  instruction_placeholder: { id: "web.repositories.deploy.instruction_placeholder", defaultMessage: "Example: deploy to the spawn servers and restart them", description: "Deploy dialog: placeholder example of an instruction for the assistant" },
  approval: { id: "web.repositories.deploy.approval", defaultMessage: "The assistant asks you to approve before it deploys. It runs with your permissions.", description: "Deploy dialog: note that the assistant asks before deploying" },
  ask: { id: "web.repositories.deploy.ask", defaultMessage: "Ask Assistant", description: "Deploy dialog: button that opens the assistant with the instruction; keep it short" },
  seed: { id: "web.repositories.deploy.seed", defaultMessage: "Build #{number}, artifact {artifact}. Deploy it as follows: {instruction}", description: "Deploy dialog: first message the assistant receives; {number} is the build number, {artifact} the jar path and {instruction} what the user asked for" },
});

interface DeployModalProps {
  repository: Repository;
  build: Build;
  artifactPath: string;
  onAskAssistant: (prompt: string) => void;
  onClose: () => void;
}

export function DeployModal({ repository, build, artifactPath, onAskAssistant, onClose }: DeployModalProps) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const qc = useQueryClient();
  const fleet = useFleetServers();
  const jars = deployableJars(build);
  const [mode, setMode] = useState<"manual" | "assistant">("manual");
  const [artifact, setArtifact] = useState(artifactPath);
  const [filename, setFilename] = useState<string | null>(null);
  const [dir, setDir] = useState("plugins");
  const [selected, setSelected] = useState<FleetItem<GameServer>[]>([]);
  const [removeOverride, setRemoveOverride] = useState<string[] | null>(null);
  const [restart, setRestart] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [result, setResult] = useState<DeployResult | null>(null);
  const artifactName = baseName(artifact);
  const effectiveFilename = filename ?? artifactName;
  const folder = dir.trim().replace(/^\/+|\/+$/g, "");
  const prefix = artifactPrefix(artifactName);
  const writable = (fleet.data?.items ?? []).filter((item) => item.access?.canWrite === true);

  const listings = useQueries({
    queries: selected.map((item) => ({
      queryKey: ["repositories", "deploy-files", targetKey(item.target), folder],
      queryFn: ({ signal }: { signal: AbortSignal }) => listFolder(item, folder, signal),
    })),
  });
  const found = new Map(selected.map((item, index) => [targetKey(item.target), listings[index]?.data ?? []]));
  const suggestions = [...new Set([...found.values()].flat()
    .filter((entry) => !entry.dir && entry.name.startsWith(`${prefix}-`) && entry.name.endsWith(".jar") && entry.name !== effectiveFilename)
    .map((entry) => entry.name))].sort();
  const removed = removeOverride ?? suggestions;
  const targets = selected.map((item) => ({ cluster: item.target.cluster, namespace: item.target.namespace, server: item.target.name }));

  const deploy = useMutation({
    mutationFn: () => Builds.deploy(repository.name, build.number, { artifact, targets, dir: folder, filename: effectiveFilename, remove: removed.filter((jar) => jar !== effectiveFilename), restart }, repository.namespace),
    onSuccess: async (data) => {
      setResult(data);
      await qc.invalidateQueries({ queryKey: buildsKey(repository.namespace, repository.name) });
    },
  });

  const toggle = (item: FleetItem<GameServer>) => {
    const key = targetKey(item.target);
    setSelected((current) => current.some((candidate) => targetKey(candidate.target) === key)
      ? current.filter((candidate) => targetKey(candidate.target) !== key)
      : [...current, item]);
  };
  const toggleRemove = (jar: string) => setRemoveOverride(removed.includes(jar) ? removed.filter((name) => name !== jar) : [...removed, jar]);
  const pickArtifact = (path: string) => {
    setArtifact(path);
    setFilename(null);
    setRemoveOverride(null);
  };
  const servers = intl.formatMessage(M.selected, { count: selected.length });
  const sendToAssistant = () => {
    onAskAssistant(intl.formatMessage(M.seed, { number: build.number, artifact, instruction: instruction.trim() }));
    onClose();
  };

  return (
    <Modal isOpen onOpenChange={(open) => { if (!open) onClose(); }}>
      <ModalBackdrop isDismissable={!deploy.isPending} isKeyboardDismissDisabled={deploy.isPending}>
        <ModalContainer>
          <ModalDialog className="h-dvh w-full max-w-lg rounded-none sm:h-auto sm:max-h-[90dvh] sm:rounded-2xl">
            <ModalHeader>
              <Rocket className="h-5 w-5 text-accent" aria-hidden="true" />
              <ModalHeading>{intl.formatMessage(M.title, { artifact: artifactName })}</ModalHeading>
            </ModalHeader>
            <ModalBody className="flex flex-col gap-4 overflow-y-auto">
              {result ? (
                <DeployResultView result={result} />
              ) : (
                <>
                  <div className="inline-flex w-fit rounded-full border border-border p-0.5 text-xs">
                    <button type="button" aria-pressed={mode === "manual"} onClick={() => setMode("manual")} className={cn("rounded-full px-3 py-1", mode === "manual" && "bg-accent/10 text-accent")}>
                      {intl.formatMessage(M.manual)}
                    </button>
                    <button type="button" aria-pressed={mode === "assistant"} onClick={() => setMode("assistant")} className={cn("inline-flex items-center gap-1 rounded-full px-3 py-1", mode === "assistant" && "bg-accent/10 text-accent")}>
                      <Sparkles className="h-3 w-3" aria-hidden="true" />{intl.formatMessage(M.with_assistant)}
                    </button>
                  </div>
                  <p className="text-sm text-muted">{intl.formatMessage(M.intro)}</p>

                  {mode === "manual" ? (
                    <>
                      <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-medium">{intl.formatMessage(M.artifact)}</span>
                        <select value={artifact} onChange={(e) => pickArtifact(e.target.value)} className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm">
                          {jars.map((jar) => (
                            <option key={jar.path} value={jar.path}>{joinDot(intl, [jar.path, sizeLabel(intl, format, jar.size)])}</option>
                          ))}
                        </select>
                        <span className="text-xs text-muted">{intl.formatMessage(M.artifact_hint)}</span>
                      </label>

                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium">{joinDot(intl, [intl.formatMessage(M.servers), servers])}</span>
                        </div>
                        <ServerPicker
                          items={writable}
                          selected={selected}
                          onToggle={toggle}
                          rowText={(item) => rowText(item, found.get(targetKey(item.target)), prefix, intl)}
                        />
                        <span className="text-xs text-muted">{intl.formatMessage(M.servers_hint)}</span>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className="flex flex-col gap-1.5 text-sm">
                          <span className="font-medium">{intl.formatMessage(M.folder)}</span>
                          <Input aria-label={intl.formatMessage(M.folder)} value={dir} onChange={(e) => setDir(e.target.value)} />
                          <span className="text-xs text-muted">{intl.formatMessage(M.folder_hint)}</span>
                        </label>
                        <label className="flex flex-col gap-1.5 text-sm">
                          <span className="font-medium">{intl.formatMessage(M.file_name)}</span>
                          <Input aria-label={intl.formatMessage(M.file_name)} value={effectiveFilename} onChange={(e) => setFilename(e.target.value)} />
                          <span className="text-xs text-muted">{intl.formatMessage(M.file_name_hint)}</span>
                        </label>
                      </div>

                      {suggestions.length > 0 && (
                        <div className="flex flex-col gap-2">
                          <span className="text-sm font-medium">{intl.formatMessage(M.remove)}</span>
                          <div className="flex flex-wrap gap-1.5">
                            {suggestions.map((jar) => (
                              <button
                                key={jar}
                                type="button"
                                aria-pressed={removed.includes(jar)}
                                onClick={() => toggleRemove(jar)}
                                className={cn("inline-flex h-7 items-center gap-1 rounded-full px-2.5 font-mono text-xs", removed.includes(jar) ? "bg-accent/10 text-accent" : "border border-border text-muted")}
                              >
                                {removed.includes(jar) && <X className="h-3 w-3" aria-hidden="true" />}
                                {jar}
                              </button>
                            ))}
                          </div>
                          <span className="text-xs text-muted">{intl.formatMessage(M.remove_hint, { prefix })}</span>
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{intl.formatMessage(M.restart)}</div>
                          <div className="text-xs text-muted">{intl.formatMessage(M.restart_hint)}</div>
                        </div>
                        <Switch aria-label={intl.formatMessage(M.restart)} isSelected={restart} onChange={setRestart}>
                          <Switch.Content>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                          </Switch.Content>
                        </Switch>
                      </div>

                      <div className="flex gap-3 rounded-xl border border-accent/30 bg-accent/5 p-3 text-sm">
                        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                        <div>
                          <div className="font-medium">{intl.formatMessage(M.permissions_title)}</div>
                          <p className="text-xs text-muted">{intl.formatMessage(M.permissions_body)}</p>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-sm">{intl.formatMessage(M.assistant_intro)}</p>
                      <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-medium">{intl.formatMessage(M.instruction)}</span>
                        <textarea
                          value={instruction}
                          onChange={(e) => setInstruction(e.target.value)}
                          placeholder={intl.formatMessage(M.instruction_placeholder)}
                          className="min-h-32 w-full rounded-lg border border-border bg-surface p-3 text-sm"
                        />
                      </label>
                      <p className="flex items-start gap-2 text-xs text-muted">
                        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                        {intl.formatMessage(M.approval)}
                      </p>
                    </>
                  )}
                  {deploy.error && <ErrorBanner err={gitErrorText(intl, deploy.error)} onDismiss={() => deploy.reset()} />}
                </>
              )}
            </ModalBody>
            <ModalFooter className="flex items-center justify-end gap-2">
              {result ? (
                <Button variant="primary" size="sm" onPress={onClose}>{intl.formatMessage(M.done)}</Button>
              ) : mode === "manual" ? (
                <>
                  <Button variant="ghost" size="sm" onPress={onClose} isDisabled={deploy.isPending}>{intl.formatMessage(M.cancel)}</Button>
                  <Button variant="primary" size="sm" isDisabled={selected.length === 0 || deploy.isPending} onPress={() => deploy.mutate()}>
                    {intl.formatMessage(M.deploy_count, { count: selected.length })}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onPress={onClose}>{intl.formatMessage(M.cancel)}</Button>
                  <Button variant="primary" size="sm" isDisabled={instruction.trim() === ""} onPress={sendToAssistant}>
                    <Sparkles className="h-3.5 w-3.5" />{intl.formatMessage(M.ask)}
                  </Button>
                </>
              )}
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}

function DeployResultView({ result }: { result: DeployResult }) {
  const intl = useOptionalIntl();
  const { targets } = result.deployment;
  const ok = targets.filter((target) => target.ok).length;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">{intl.formatMessage(M.result, { ok, total: targets.length })}</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {targets.map((target) => (
          <li key={`${target.cluster}/${target.namespace}/${target.server}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <span className="font-mono text-xs">{target.server}</span>
            {target.ok
              ? <Check className="h-4 w-4 text-success" aria-hidden="true" />
              : <span className="text-xs text-danger">{intl.formatMessage(M.result_failed, { error: target.error ?? "" })}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function rowText(item: FleetItem<GameServer>, entries: FileEntry[] | undefined, prefix: string, intl: ReturnType<typeof useOptionalIntl>): string {
  const phase = item.resource.status?.phase;
  const jar = entries?.find((entry) => !entry.dir && entry.name.startsWith(`${prefix}-`) && entry.name.endsWith(".jar"));
  return joinDot(intl, [
    intl.formatMessage(M.runtime_template, { template: item.resource.spec.templateRef.name }),
    phase,
    jar && intl.formatMessage(M.has_jar, { file: jar.name }),
  ]);
}

function deployableJars(build: Build): BuildArtifact[] {
  return build.artifacts.filter((artifact) => artifact.name.endsWith(".jar") && !artifact.name.startsWith("original-") && !/-(sources|javadoc)\.jar$/.test(artifact.name));
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function artifactPrefix(name: string): string {
  return name.replace(/\.jar$/, "").replace(/-\d.*$/, "");
}

function listFolder(item: FleetItem<GameServer>, dir: string, signal: AbortSignal): Promise<FileEntry[]> {
  const query = new URLSearchParams({ path: `/${dir}`, namespace: item.target.namespace });
  return api<FileEntry[]>(`/servers/${encodeURIComponent(item.target.name)}/files/list?${query}`, { cluster: item.target.cluster, signal });
}
