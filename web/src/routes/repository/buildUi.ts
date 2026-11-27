import { useEffect, useState } from "react";
import { defineMessages, type IntlShape, type MessageDescriptor } from "react-intl";
import type { FormatApi } from "@/lib/i18n/format";
import type { Build, BuildPhase, BuildTool } from "@/types";

const PHASE = defineMessages({
  Queued: { id: "web.repositories.builds.phase_queued", defaultMessage: "Queued", description: "Builds: phase of a build waiting behind another build of the same repository; keep it short" },
  Pending: { id: "web.repositories.builds.phase_pending", defaultMessage: "Pending", description: "Builds: phase of a build whose pod is still starting; keep it short" },
  Running: { id: "web.repositories.builds.phase_running", defaultMessage: "Running", description: "Builds: phase of a build that is running right now; keep it short" },
  Succeeded: { id: "web.repositories.builds.phase_succeeded", defaultMessage: "Succeeded", description: "Builds: phase of a build that finished without errors; keep it short" },
  Failed: { id: "web.repositories.builds.phase_failed", defaultMessage: "Failed", description: "Builds: phase of a build that failed; keep it short" },
});

const TOOL = defineMessages({
  auto: { id: "web.repositories.builds.tool_auto", defaultMessage: "Auto", description: "Builds: build tool setting that picks Maven or Gradle from the repository files; keep it short" },
  maven: { id: "web.repositories.builds.tool_maven", defaultMessage: "Maven", description: "Builds: name of the Maven build tool; a product name, usually left untranslated" },
  gradle: { id: "web.repositories.builds.tool_gradle", defaultMessage: "Gradle", description: "Builds: name of the Gradle build tool; a product name, usually left untranslated" },
});

const UI: Record<string, MessageDescriptor> = defineMessages({
  build_number: { id: "web.repositories.builds.build_number", defaultMessage: "#{number}", description: "Builds: short label of a build, with its sequence number; {number} is the build number" },
  seconds: { id: "web.repositories.builds.seconds", defaultMessage: "{seconds} s", description: "Builds: duration of a build in seconds; {seconds} is the formatted number" },
  size_mb: { id: "web.repositories.builds.size_mb", defaultMessage: "{size} MB", description: "Builds: size in megabytes; {size} is the formatted number" },
  size_gb: { id: "web.repositories.builds.size_gb", defaultMessage: "{size} GB", description: "Builds: size in gigabytes; {size} is the formatted number" },
  uncommitted: { id: "web.repositories.builds.uncommitted", defaultMessage: "+ {count} uncommitted", description: "Builds: source of a build that includes uncommitted files; {count} is the number of files" },
  starter: { id: "web.repositories.builds.starter", defaultMessage: "@{name}", description: "Builds: who started a build, prefixed with an at sign; {name} is the user's login" },
  assistant: { id: "web.repositories.builds.assistant", defaultMessage: "Assistant", description: "Builds: who started a build when the assistant asked for it; keep it short" },
  empty: { id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" },
  dot: { id: "web.common.separator_dot", defaultMessage: "·", description: "Visual separator between two items" },
});

const ESCAPE = String.fromCharCode(27);
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;?]*[A-Za-z]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export function joinDot(intl: IntlShape, parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(` ${intl.formatMessage(UI.dot)} `);
}

export function phaseLabel(intl: IntlShape, phase: BuildPhase): string {
  return intl.formatMessage(PHASE[phase]);
}

export function phaseTone(phase: BuildPhase): string {
  if (phase === "Succeeded") return "bg-success";
  if (phase === "Failed") return "bg-danger";
  if (phase === "Running" || phase === "Pending" || phase === "Queued") return "bg-warning";
  return "bg-muted";
}

export function toolLabel(intl: IntlShape, tool: BuildTool): string {
  return intl.formatMessage(TOOL[tool]);
}

export function buildTitle(intl: IntlShape, build: Build): string {
  return joinDot(intl, [intl.formatMessage(UI.build_number, { number: build.number }), phaseLabel(intl, build.phase)]);
}

export function sizeLabel(intl: IntlShape, format: FormatApi, bytes: number): string {
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  return bytes >= gib
    ? intl.formatMessage(UI.size_gb, { size: format.number(bytes / gib, { maximumFractionDigits: 1 }) })
    : intl.formatMessage(UI.size_mb, { size: format.number(bytes / mib, { maximumFractionDigits: 1 }) });
}

export function durationSeconds(build: Build, now: number): number | null {
  if (!build.startTime) return null;
  const end = build.completionTime ? Date.parse(build.completionTime) : now;
  return Math.max(0, (end - Date.parse(build.startTime)) / 1000);
}

export function durationLabel(intl: IntlShape, format: FormatApi, seconds: number | null): string {
  if (seconds === null) return "";
  return seconds < 60
    ? intl.formatMessage(UI.seconds, { seconds: format.number(seconds, { maximumFractionDigits: 1 }) })
    : format.duration(seconds);
}

export function sourceLabel(intl: IntlShape, build: Build): string {
  const commit = build.source.commit ?? intl.formatMessage(UI.empty);
  return [commit, build.source.changes > 0 && intl.formatMessage(UI.uncommitted, { count: build.source.changes })].filter(Boolean).join(" ");
}

export function starterLabel(intl: IntlShape, build: Build): string {
  if (build.via === "assistant") return intl.formatMessage(UI.assistant);
  return build.startedBy ? intl.formatMessage(UI.starter, { name: build.startedBy.name }) : intl.formatMessage(UI.empty);
}

export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
