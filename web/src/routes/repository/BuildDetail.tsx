import { useEffect, useRef, useState } from "react";
import { Button, Card } from "@heroui/react";
import { buttonVariants } from "@heroui/styles";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { ArrowLeft, Copy, Download, Play, Rocket, X } from "lucide-react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { APIError } from "@/lib/api";
import { useFormat, useOptionalIntl } from "@/lib/i18n/format";
import { artifactURL, Builds, followBuildLog, gitErrorText, isActiveBuild } from "@/lib/repositories";
import { formatRelative, cn } from "@/lib/utils";
import type { Build, Deployment, Repository } from "@/types";
import { DeployModal } from "./DeployModal";
import { buildTitle, durationLabel, durationSeconds, joinDot, sizeLabel, sourceLabel, starterLabel, stripAnsi, toolLabel } from "./buildUi";

const M: Record<string, MessageDescriptor> = defineMessages({
  back: { id: "web.repositories.builds.back", defaultMessage: "Builds", description: "Builds: back button on small screens that returns from a build to the list; keep it short" },
  rebuild: { id: "web.repositories.builds.rebuild", defaultMessage: "Rebuild", description: "Builds: button that starts a new build with the same settings; keep it short" },
  cancel: { id: "web.repositories.builds.cancel", defaultMessage: "Cancel build", description: "Builds: button that cancels a running build; keep it short" },
  limits: { id: "web.repositories.builds.limits", defaultMessage: "{cpu} CPU / {memory}", description: "Builds: CPU and memory limits a build ran with; {cpu} is the core count and {memory} the memory size" },
  started_by: { id: "web.repositories.builds.started_by", defaultMessage: "started by {who}", description: "Builds: who started the build; {who} is the user or Assistant" },
  artifacts_title: { id: "web.repositories.builds.artifacts_title", defaultMessage: "Artifacts", description: "Builds: title of the card that lists the jars a build produced" },
  shaded: { id: "web.repositories.builds.shaded", defaultMessage: "shaded", description: "Builds: note on an artifact whose dependencies were shaded in; keep it short" },
  built_from: { id: "web.repositories.builds.built_from", defaultMessage: "built from {source}", description: "Builds: where an artifact was built from; {source} is the commit and uncommitted changes" },
  download: { id: "web.repositories.builds.download", defaultMessage: "Download", description: "Builds: button that downloads a build artifact; keep it short" },
  deploy: { id: "web.repositories.builds.deploy", defaultMessage: "Deploy to servers…", description: "Builds: button that opens the deploy dialog for an artifact; keep it short" },
  deployments_title: { id: "web.repositories.builds.deployments_title", defaultMessage: "Deployments", description: "Builds: title of the card that lists where a build was deployed" },
  deploy_written: { id: "web.repositories.builds.deploy_written", defaultMessage: "{ok} / {total} written", description: "Builds: result of a deployment; {ok} is the servers written and {total} the servers targeted" },
  deploy_line: { id: "web.repositories.builds.deploy_line", defaultMessage: "{targets} → {path}", description: "Builds: one deployment, the target servers, an arrow, then the file path written; {targets} is a list of server names" },
  deploy_removed: { id: "web.repositories.builds.deploy_removed", defaultMessage: "Removed {files}", description: "Builds: note listing the old jars a deployment removed; {files} is a comma-separated list of file names" },
  deploy_restart: { id: "web.repositories.builds.deploy_restart", defaultMessage: "restart", description: "Builds: note that a deployment restarted the servers; keep it short" },
  deploy_no_restart: { id: "web.repositories.builds.deploy_no_restart", defaultMessage: "no restart", description: "Builds: note that a deployment did not restart the servers; keep it short" },
  deploy_by: { id: "web.repositories.builds.deploy_by", defaultMessage: "by {who}", description: "Builds: who made a deployment; {who} is the user or Assistant" },
  deploy_assistant: { id: "web.repositories.builds.deploy_assistant", defaultMessage: "Assistant", description: "Builds: name of the assistant when it made a deployment; keep it short" },
  jdk: { id: "web.repositories.builds.jdk_short", defaultMessage: "JDK {version}", description: "Builds: Java version a build runs with, in the build header; {version} is 17, 21 or 25" },
  deploy_approved: { id: "web.repositories.builds.deploy_approved", defaultMessage: "approved by {who}", description: "Builds: who approved a deployment the assistant made; {who} is the user" },
  deploy_error: { id: "web.repositories.builds.deploy_error", defaultMessage: "{server}: {error}", description: "Builds: a server that a deployment could not write; {server} is the server name and {error} the reason" },
  log_title: { id: "web.repositories.builds.log_title", defaultMessage: "Log", description: "Builds: title of the build log card" },
  follow: { id: "web.repositories.builds.follow", defaultMessage: "Follow", description: "Builds: toggle that keeps the live log scrolled to the newest line; keep it short" },
  copy: { id: "web.repositories.builds.copy", defaultMessage: "Copy", description: "Builds: button that copies the build log; keep it short" },
  download_log: { id: "web.repositories.builds.download_log", defaultMessage: "Download", description: "Builds: button that downloads the build log as a file; keep it short" },
  log_loading: { id: "web.repositories.builds.log_loading", defaultMessage: "Loading log…", description: "Builds: text shown while the build log is loading" },
  log_empty: { id: "web.repositories.builds.log_empty", defaultMessage: "No output yet.", description: "Builds: text shown when a build has not printed anything yet" },
  log_gone: { id: "web.repositories.builds.log_gone", defaultMessage: "The log is no longer available. Its build pod was removed.", description: "Builds: text shown when the pod of a finished build no longer exists" },
});

interface BuildDetailProps {
  repository: Repository;
  build: Build;
  canWrite: boolean;
  now: number;
  busy: boolean;
  onBack: () => void;
  onRebuild: (build: Build) => void;
  onCancel: (build: Build) => void;
  onAskAssistant: (prompt: string) => void;
}

export function BuildDetail({ repository, build, canWrite, now, busy, onBack, onRebuild, onCancel, onAskAssistant }: BuildDetailProps) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const [deployArtifact, setDeployArtifact] = useState<string | null>(null);
  const active = isActiveBuild(build.phase);
  const seconds = durationSeconds(build, now);
  const meta = joinDot(intl, [
    toolLabel(intl, build.tool),
    intl.formatMessage(M.jdk, { version: build.jdk }),
    build.args,
    durationLabel(intl, format, seconds),
    intl.formatMessage(M.limits, { cpu: build.limits.cpu, memory: build.limits.memory }),
    intl.formatMessage(M.started_by, { who: starterLabel(intl, build) }),
    formatRelative(build.createdAt, intl),
  ]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Button variant="ghost" size="sm" className="w-fit lg:hidden" onPress={onBack}>
        <ArrowLeft className="h-4 w-4" />{intl.formatMessage(M.back)}
      </Button>
      <Card className="border border-border">
        <Card.Content className="flex-row flex-wrap items-start justify-between gap-3 p-5">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{buildTitle(intl, build)}</h2>
            <p className="text-xs text-muted">{meta}</p>
          </div>
          {canWrite && active && (
            <Button variant="danger" size="sm" isDisabled={busy} onPress={() => onCancel(build)}>
              <X className="h-4 w-4" />{intl.formatMessage(M.cancel)}
            </Button>
          )}
          {canWrite && !active && (
            <Button variant="outline" size="sm" isDisabled={busy} onPress={() => onRebuild(build)}>
              <Play className="h-4 w-4" />{intl.formatMessage(M.rebuild)}
            </Button>
          )}
          {build.phase === "Failed" && build.message && <p className="w-full text-sm text-danger">{build.message}</p>}
        </Card.Content>
      </Card>

      {build.artifacts.length > 0 && (
        <Card className="border border-border">
          <Card.Content className="gap-3 p-5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">{intl.formatMessage(M.artifacts_title)}</h3>
            {build.artifacts.map((artifact) => (
              <div key={artifact.path} className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm">{artifact.path}</p>
                  <p className="text-xs text-muted">
                    {joinDot(intl, [
                      sizeLabel(intl, format, artifact.size),
                      artifact.shaded && intl.formatMessage(M.shaded),
                      intl.formatMessage(M.built_from, { source: sourceLabel(intl, build) }),
                    ])}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <a href={artifactURL(repository.name, artifact.path, repository.namespace)} download className={buttonVariants({ variant: "outline", size: "sm" })}>
                    <Download className="h-4 w-4" />{intl.formatMessage(M.download)}
                  </a>
                  {build.phase === "Succeeded" && (
                    <Button variant="primary" size="sm" isDisabled={busy} onPress={() => setDeployArtifact(artifact.path)}>
                      <Rocket className="h-4 w-4" />{intl.formatMessage(M.deploy)}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </Card.Content>
        </Card>
      )}

      {build.deployments.length > 0 && (
        <Card className="border border-border">
          <Card.Content className="gap-3 p-5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">{intl.formatMessage(M.deployments_title)}</h3>
            {[...build.deployments].reverse().map((deployment) => (
              <DeploymentRow key={deployment.id} deployment={deployment} />
            ))}
          </Card.Content>
        </Card>
      )}

      <BuildLog name={repository.name} namespace={repository.namespace} build={build} />

      {deployArtifact !== null && (
        <DeployModal
          repository={repository}
          build={build}
          artifactPath={deployArtifact}
          onAskAssistant={onAskAssistant}
          onClose={() => setDeployArtifact(null)}
        />
      )}
    </div>
  );
}

function DeploymentRow({ deployment }: { deployment: Deployment }) {
  const intl = useOptionalIntl();
  const ok = deployment.targets.filter((target) => target.ok).length;
  const total = deployment.targets.length;
  const partial = ok < total;
  const path = `${deployment.dir}/${deployment.filename}`;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm">
          {intl.formatMessage(M.deploy_line, { targets: deployment.targets.map((target) => target.server).join(", "), path })}
        </p>
        <p className="text-xs text-muted">
          {joinDot(intl, [
            deployment.removed.length > 0 && intl.formatMessage(M.deploy_removed, { files: deployment.removed.join(", ") }),
            intl.formatMessage(deployment.restart ? M.deploy_restart : M.deploy_no_restart),
            intl.formatMessage(M.deploy_by, { who: deployment.via === "assistant" ? intl.formatMessage(M.deploy_assistant) : deployment.actor.name }),
            deployment.approvedBy && intl.formatMessage(M.deploy_approved, { who: deployment.approvedBy }),
            formatRelative(deployment.time, intl),
          ])}
        </p>
        {deployment.targets.filter((target) => !target.ok).map((target) => (
          <p key={`${target.cluster}/${target.namespace}/${target.server}`} className="text-xs text-danger">
            {intl.formatMessage(M.deploy_error, { server: target.server, error: target.error ?? "" })}
          </p>
        ))}
      </div>
      <span className={cn("shrink-0 rounded-full px-2.5 py-1 text-xs font-medium", partial ? "bg-danger/10 text-danger" : "bg-success/15 text-success")}>
        {intl.formatMessage(M.deploy_written, { ok, total })}
      </span>
    </div>
  );
}

function BuildLog({ name, namespace, build }: { name: string; namespace: string; build: Build }) {
  const intl = useOptionalIntl();
  const live = isActiveBuild(build.phase);
  const [follow, setFollow] = useState(true);
  const [log, setLog] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const scroller = useRef<HTMLPreElement>(null);
  const streaming = live && follow;
  const waiting = live && error instanceof APIError && error.status === 404;

  useEffect(() => {
    const controller = new AbortController();
    let retry: number | undefined;
    setLog("");
    setLoaded(false);
    setError(null);
    const load = streaming
      ? followBuildLog(name, build.number, namespace, (chunk) => setLog((text) => text + chunk), controller.signal)
      : Builds.logText(name, build.number, namespace, controller.signal).then((text) => setLog(text));
    void load
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err);
        if (live && err instanceof APIError && err.status === 404) retry = window.setTimeout(() => setAttempt((count) => count + 1), 2000);
      })
      .finally(() => { if (!controller.signal.aborted) setLoaded(true); });
    return () => {
      controller.abort();
      window.clearTimeout(retry);
    };
  }, [name, namespace, build.number, streaming, live, attempt]);

  useEffect(() => {
    if (streaming && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [log, streaming]);

  const text = stripAnsi(log);
  const copy = () => void navigator.clipboard.writeText(text);
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}-build-${build.number}.log`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="border border-border">
      <Card.Content className="gap-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">{intl.formatMessage(M.log_title)}</h3>
          <div className="flex items-center gap-1">
            {live && (
              <Button variant="ghost" size="sm" aria-pressed={follow} onPress={() => setFollow((value) => !value)}>{intl.formatMessage(M.follow)}</Button>
            )}
            <Button variant="ghost" size="sm" onPress={copy} isDisabled={!text}>
              <Copy className="h-3.5 w-3.5" />{intl.formatMessage(M.copy)}
            </Button>
            <Button variant="ghost" size="sm" onPress={download} isDisabled={!text}>
              <Download className="h-3.5 w-3.5" />{intl.formatMessage(M.download_log)}
            </Button>
          </div>
        </div>
        {error && !waiting ? <ErrorBanner err={error instanceof APIError && error.status === 404 ? intl.formatMessage(M.log_gone) : gitErrorText(intl, error)} /> : null}
        <pre ref={scroller} className="max-h-96 min-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-surface-secondary p-4 font-mono text-xs text-foreground scrollbar-thin">
          {text || (loaded ? intl.formatMessage(M.log_empty) : intl.formatMessage(M.log_loading))}
        </pre>
      </Card.Content>
    </Card>
  );
}
