import { useEffect, useState } from "react";
import { AlertTriangle, Copy } from "lucide-react";
import { Alert, Button, Input, TextArea } from "@heroui/react";

import { SegmentedControl } from "@/components/statistics/SegmentedControl";
import { useResourceAccess } from "@/lib/resourceTarget";
import { cn, formatBytes, parseQuantityToBytes } from "@/lib/utils";
import { useOptionalIntl } from "@/lib/i18n/format";
import type { SectionProps } from "./types";

export const STARTUP_KEYS = ["INIT_MEMORY", "MAX_MEMORY", "JVM_XX_OPTS"];

export const AIKAR_FLAGS = [
  "-XX:+UseG1GC",
  "-XX:+ParallelRefProcEnabled",
  "-XX:MaxGCPauseMillis=200",
  "-XX:+UnlockExperimentalVMOptions",
  "-XX:+DisableExplicitGC",
  "-XX:+AlwaysPreTouch",
  "-XX:G1NewSizePercent=30",
  "-XX:G1MaxNewSizePercent=40",
  "-XX:G1HeapRegionSize=8M",
  "-XX:G1ReservePercent=20",
  "-XX:G1HeapWastePercent=5",
  "-XX:G1MixedGCCountTarget=4",
  "-XX:InitiatingHeapOccupancyPercent=15",
  "-XX:G1MixedGCLiveThresholdPercent=90",
  "-XX:G1RSetUpdatingPauseTimePercent=5",
  "-XX:SurvivorRatio=32",
  "-XX:+PerfDisableSharedMem",
  "-XX:MaxTenuringThreshold=1",
  "-Dusing.aikars.flags=https://mcflags.emc.gs",
  "-Daikars.new.flags=true",
].join(" ");

const MIB = 1024 ** 2;
const JVM_SIZE_UNITS: Record<string, number> = { "": 1, K: 1024, M: MIB, G: 1024 ** 3 };

export function jvmSizeBytes(value: string): number | null {
  const match = /^(\d+)([kmg]?)$/i.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * JVM_SIZE_UNITS[match[2].toUpperCase()];
}

const normalizeFlags = (flags: string) => flags.trim().split(/\s+/).filter(Boolean).join(" ");

type Preset = "none" | "aikar" | "custom";

export function StartupSection({ draft, onChange, template, onValidityChange }: SectionProps) {
  const intl = useOptionalIntl();
  const canWrite = useResourceAccess()?.canWrite === true;
  const schema = template?.spec.configSchema ?? [];
  const config = draft.spec.config ?? {};
  const field = (name: string) => schema.find((candidate) => candidate.name === name);
  const maxField = field("MAX_MEMORY");
  const initField = field("INIT_MEMORY");
  const flagsField = field("JVM_XX_OPTS");

  const limitBytes = parseQuantityToBytes(draft.spec.resources?.limits?.memory ?? template?.spec.resources?.limits?.memory);
  const percent = maxField?.autoFromMemoryLimit?.percent;
  const autoHeap = limitBytes > 0 && percent ? `${Math.floor((limitBytes * percent) / 100 / MIB)}M` : "";
  const maxHeap = config.MAX_MEMORY ?? maxField?.default ?? "";
  const initHeap = config.INIT_MEMORY ?? initField?.default ?? "";
  const effectiveMax = maxHeap || autoHeap;
  const effectiveInit = initHeap || effectiveMax;
  const flags = config.JVM_XX_OPTS ?? flagsField?.default ?? "";

  const [custom, setCustom] = useState(false);
  const detected: Preset = normalizeFlags(flags) === "" ? "none" : normalizeFlags(flags) === AIKAR_FLAGS ? "aikar" : "custom";
  const preset: Preset = custom ? "custom" : detected;

  const maxBytes = effectiveMax ? jvmSizeBytes(effectiveMax) : null;
  const initBytes = effectiveInit ? jvmSizeBytes(effectiveInit) : null;
  const maxError = maxHeap && jvmSizeBytes(maxHeap) === null
    ? intl.formatMessage({ id: "web.routes.tabs.settings.startup.invalid_size", defaultMessage: "Use a whole number with an optional K, M or G suffix, like 3G or 3072M.", description: "Startup: inline error under a heap size field whose value is not a valid JVM size" })
    : null;
  const initError = initHeap && jvmSizeBytes(initHeap) === null
    ? intl.formatMessage({ id: "web.routes.tabs.settings.startup.invalid_size", defaultMessage: "Use a whole number with an optional K, M or G suffix, like 3G or 3072M.", description: "Startup: inline error under a heap size field whose value is not a valid JVM size" })
    : initBytes !== null && maxBytes !== null && initBytes > maxBytes
      ? intl.formatMessage({ id: "web.routes.tabs.settings.startup.initial_above_max", defaultMessage: "Initial heap can't be larger than max heap.", description: "Startup: inline error under the initial heap field when it is larger than the max heap" })
      : null;
  const valid = !maxError && !initError;
  useEffect(() => {
    onValidityChange?.(valid);
  }, [valid, onValidityChange]);

  const setValue = (name: string, value: string) => {
    const next = { ...config };
    if (value === "" || value === (field(name)?.default ?? "")) delete next[name];
    else next[name] = value;
    onChange({ ...draft, spec: { ...draft.spec, config: Object.keys(next).length > 0 ? next : undefined } });
  };

  const choosePreset = (next: Preset) => {
    setCustom(next === "custom");
    if (next === "none") setValue("JVM_XX_OPTS", "");
    if (next === "aikar") setValue("JVM_XX_OPTS", AIKAR_FLAGS);
  };

  const command = [
    "java",
    effectiveInit && `-Xms${effectiveInit}`,
    effectiveMax && `-Xmx${effectiveMax}`,
    normalizeFlags(flags),
    "-jar server.jar nogui",
  ].filter(Boolean).join(" ");

  const overLimit = limitBytes > 0 && maxBytes !== null && maxBytes >= limitBytes;
  const usage = limitBytes > 0 && maxBytes !== null ? Math.min(100, (maxBytes / limitBytes) * 100) : null;

  return (
    <div className="space-y-5">
      {canWrite && (
        <Alert status="warning">
          <Alert.Indicator>
            <AlertTriangle className="h-5 w-5 shrink-0" />
          </Alert.Indicator>
          <Alert.Content>{intl.formatMessage({ id: "web.routes.tabs.settings.startup.saving_restarts", defaultMessage: "Saving changes restarts the server so they apply.", description: "Startup: warning note saying that saving restarts the server so the changes apply" })}</Alert.Content>
        </Alert>
      )}

      {maxField && (
        <section className="space-y-4 rounded-xl border border-border bg-card p-5">
          <div>
            <h3 className="text-[15px] font-semibold text-fg">{intl.formatMessage({ id: "web.routes.tabs.settings.startup.java_heap", defaultMessage: "Java heap", description: "Startup: title of the card with the JVM heap size fields" })}</h3>
            <p className="pt-1 text-[13px] text-muted">{intl.formatMessage({ id: "web.routes.tabs.settings.startup.java_heap_hint", defaultMessage: "Leave empty to size automatically to {percent}% of the container memory limit.", description: "Startup: hint under the Java heap title; {percent} is the share of the container memory limit used when the fields are empty" }, { percent: String(percent ?? 75) })}</p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {initField && (
              <HeapInput
                label={intl.formatMessage({ id: "web.routes.tabs.settings.startup.initial_heap", defaultMessage: "Initial heap (-Xms)", description: "Startup: label of the initial JVM heap size field; -Xms is the Java flag, keep it untranslated" })}
                value={initHeap}
                placeholder={effectiveMax ? intl.formatMessage({ id: "web.routes.tabs.settings.startup.same_as_max", defaultMessage: "Same as max ({size})", description: "Startup: placeholder of the empty initial heap field; {size} is the max heap it falls back to" }, { size: effectiveMax }) : ""}
                hint={intl.formatMessage({ id: "web.routes.tabs.settings.startup.initial_heap_hint", defaultMessage: "Starting heap. Leave empty to match max heap.", description: "Startup: hint under the initial heap field" })}
                error={initError}
                disabled={!canWrite}
                onChange={(value) => setValue("INIT_MEMORY", value)}
              />
            )}
            <HeapInput
              label={intl.formatMessage({ id: "web.routes.tabs.settings.startup.max_heap", defaultMessage: "Max heap (-Xmx)", description: "Startup: label of the max JVM heap size field; -Xmx is the Java flag, keep it untranslated" })}
              value={maxHeap}
              placeholder={autoHeap ? intl.formatMessage({ id: "web.routes.tabs.settings.startup.auto_size", defaultMessage: "Auto ({size})", description: "Startup: placeholder of the empty max heap field; {size} is the automatically computed heap" }, { size: autoHeap }) : ""}
              hint={intl.formatMessage({ id: "web.routes.tabs.settings.startup.max_heap_hint", defaultMessage: "e.g. 3G or 3072M. Keep about 25% below the limit.", description: "Startup: hint under the max heap field with example values" })}
              error={maxError}
              disabled={!canWrite}
              onChange={(value) => setValue("MAX_MEMORY", value)}
            />
          </div>

          {usage !== null && maxBytes !== null && (
            <div className="space-y-1.5">
              <div className="h-2 overflow-hidden rounded-full bg-default">
                <div className={cn("h-full rounded-full", overLimit ? "bg-danger" : "bg-accent")} style={{ width: `${usage}%` }} />
              </div>
              <p className={cn("text-xs", overLimit ? "text-danger" : "text-muted")}>
                {overLimit
                  ? intl.formatMessage({ id: "web.routes.tabs.settings.startup.heap_over_limit", defaultMessage: "Heap {heap} reaches the {limit} container limit. The server will be OOM-killed.", description: "Startup: danger note under the heap bar when the max heap is at or above the container memory limit; {heap} and {limit} are sizes" }, { heap: formatBytes(maxBytes), limit: formatBytes(limitBytes) })
                  : intl.formatMessage({ id: "web.routes.tabs.settings.startup.heap_usage", defaultMessage: "Heap {heap} of {limit} container limit · {free} left for non-heap memory", description: "Startup: caption under the heap bar; {heap}, {limit} and {free} are sizes" }, { heap: formatBytes(maxBytes), limit: formatBytes(limitBytes), free: formatBytes(limitBytes - maxBytes) })}
              </p>
            </div>
          )}
        </section>
      )}

      {flagsField && (
        <section className="space-y-4 rounded-xl border border-border bg-card p-5">
          <div>
            <h3 className="text-[15px] font-semibold text-fg">{intl.formatMessage({ id: "web.routes.tabs.settings.startup.jvm_flags", defaultMessage: "JVM flags", description: "Startup: title of the card with extra JVM flags" })}</h3>
            <p className="pt-1 text-[13px] text-muted">{intl.formatMessage({ id: "web.routes.tabs.settings.startup.jvm_flags_hint", defaultMessage: "Extra flags passed to java before -jar. Start from a preset or write your own.", description: "Startup: hint under the JVM flags title" })}</p>
          </div>
          <SegmentedControl<Preset>
            ariaLabel={intl.formatMessage({ id: "web.routes.tabs.settings.startup.flag_preset", defaultMessage: "JVM flag preset", description: "Startup: accessible label of the JVM flag preset switch; not shown as text" })}
            value={preset}
            onChange={choosePreset}
            options={[
              { value: "none", label: intl.formatMessage({ id: "web.routes.tabs.settings.startup.preset_none", defaultMessage: "None", description: "Startup: JVM flag preset option with no extra flags" }) },
              { value: "aikar", label: intl.formatMessage({ id: "web.routes.tabs.settings.startup.preset_aikar", defaultMessage: "Aikar's flags", description: "Startup: JVM flag preset option with Aikar's recommended G1GC flags; Aikar is a person's name" }) },
              { value: "custom", label: intl.formatMessage({ id: "web.routes.tabs.settings.startup.preset_custom", defaultMessage: "Custom", description: "Startup: JVM flag preset option for hand-written flags" }) },
            ]}
          />
          <div className="space-y-1.5">
            <TextArea
              aria-label={intl.formatMessage({ id: "web.routes.tabs.settings.startup.jvm_flags", defaultMessage: "JVM flags", description: "Startup: title of the card with extra JVM flags" })}
              value={flags}
              onChange={(event) => {
                setCustom(true);
                setValue("JVM_XX_OPTS", event.target.value);
              }}
              disabled={!canWrite}
              rows={5}
              spellCheck={false}
              placeholder={intl.formatMessage({ id: "web.routes.tabs.settings.startup.flags_placeholder", defaultMessage: "-XX:+UseG1GC -XX:MaxGCPauseMillis=200", description: "Startup: example placeholder in the empty JVM flags box; Java flags, keep untranslated" })}
              className="w-full resize-y font-mono text-xs"
            />
            <p className="text-xs text-muted">{intl.formatMessage({ id: "web.routes.tabs.settings.startup.flags_note", defaultMessage: "Space- or newline-separated. Heap flags (-Xms/-Xmx) belong in Java heap above.", description: "Startup: note under the JVM flags box" })}</p>
          </div>
        </section>
      )}

      <section className="space-y-3 rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[15px] font-semibold text-fg">{intl.formatMessage({ id: "web.routes.tabs.settings.startup.command_preview", defaultMessage: "Startup command preview", description: "Startup: title of the card showing the resulting java command" })}</h3>
          <Button variant="ghost" size="sm" onPress={() => void navigator.clipboard.writeText(command)}>
            <Copy className="h-3.5 w-3.5" />
            {intl.formatMessage({ id: "web.routes.tabs.settings.startup.copy", defaultMessage: "Copy", description: "Startup: button that copies the startup command preview" })}
          </Button>
        </div>
        <pre className="whitespace-pre-wrap break-all rounded-lg bg-default px-3.5 py-3 font-mono text-xs text-fg">{command}</pre>
        <p className="text-xs text-muted">{intl.formatMessage({ id: "web.routes.tabs.settings.startup.preview_note", defaultMessage: "Read-only. The image's launcher adds the server jar and its own arguments.", description: "Startup: note under the startup command preview" })}</p>
      </section>
    </div>
  );
}

function HeapInput({ label, value, placeholder, hint, error, disabled, onChange }: {
  label: string;
  value: string;
  placeholder: string;
  hint: string;
  error: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[13px] font-medium text-fg">{label}</span>
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value.trim())}
        disabled={disabled}
        spellCheck={false}
        className="w-full font-mono"
      />
      <span className={cn("block text-xs", error ? "text-danger" : "text-muted")}>{error ?? hint}</span>
    </label>
  );
}
