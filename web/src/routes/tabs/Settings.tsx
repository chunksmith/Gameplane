import { useResourceClient, useResourceAccess, useResourceTarget, resourceKey } from "@/lib/resourceTarget";
import { useEffect, useMemo, useRef, useState, Suspense, lazy } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Tabs } from "@heroui/react";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  HardDrive,
  Layers,
  Link2,
  MapPin,
  Network,
  RadioTower,
  Rocket,
  Settings as SettingsIcon,
  ShieldCheck,
  Sliders,
  SlidersHorizontal,
  Variable,
  type LucideIcon,
} from "lucide-react";

import type { GameServer } from "@/types";
import { APIError } from "@/lib/api";
import { errorTextIntl } from "@/lib/errors";
import { mergeDraftOntoLatest, SettingsConflictError } from "@/lib/settingsMerge";
import { validateConfig } from "@/lib/validation";
import { cn } from "@/lib/utils";


import { GeneralSection } from "./settings/General";
import { VersionSection } from "./settings/Version";
import { GameConfigSection } from "./settings/GameConfig";
import { STARTUP_KEYS, StartupSection } from "./settings/Startup";
import { ResourcesSection } from "./settings/Resources";
import { NetworkingSection } from "./settings/Networking";
import { EnvVarsSection } from "./settings/EnvVars";
import { LifecycleSection } from "./settings/Lifecycle";
import { BackupsSection } from "./settings/Backups";
import { NetworkCaptureSection } from "./settings/NetworkCapture";
import { AccessSection } from "./settings/Access";
import { ShareLinksSection } from "./settings/ShareLinks";
import { DangerSection } from "./settings/Danger";
import { useOptionalIntl } from "@/lib/i18n/format";
import { useModuleText } from "@/lib/i18n/moduleText";
import { defineMessages, type IntlShape, type MessageDescriptor } from "react-intl";
const PlacementSection = lazy(() =>
  import("./settings/Placement").then((m) => ({ default: m.PlacementSection })),
);

type SectionKey =
  | "general"
  | "version"
  | "config"
  | "startup"
  | "resources"
  | "networking"
  | "env"
  | "lifecycle"
  | "backups"
  | "capture"
  | "placement"
  | "access"
  | "sharelinks"
  | "danger";

interface Section {
  key: SectionKey;
  label: MessageDescriptor;
  icon: LucideIcon;
  description?: MessageDescriptor;
  framed?: boolean;
  divider?: boolean;
}

const SECTION_LABELS = defineMessages({
  general: { id: "web.routes.tabs.settings.section_general", defaultMessage: "General", description: "Settings: name of the General section in the settings tab list" },
  version: { id: "web.routes.tabs.settings.section_version", defaultMessage: "Version", description: "Settings: name of the Version section in the settings tab list" },
  config: { id: "web.routes.tabs.settings.section_game_configuration", defaultMessage: "Game configuration", description: "Settings: name of the Game configuration section in the settings tab list" },
  startup: { id: "web.routes.tabs.settings.section_startup", defaultMessage: "Startup", description: "Settings: name of the Startup section (Java heap and JVM flags) in the settings tab list" },
  resources: { id: "web.routes.tabs.settings.section_resources", defaultMessage: "Resources", description: "Settings: name of the Resources section in the settings tab list" },
  networking: { id: "web.routes.tabs.settings.section_networking", defaultMessage: "Networking", description: "Settings: name of the Networking section in the settings tab list" },
  env: { id: "web.routes.tabs.settings.section_environment", defaultMessage: "Environment", description: "Settings: name of the Environment section in the settings tab list" },
  lifecycle: { id: "web.routes.tabs.settings.section_lifecycle", defaultMessage: "Lifecycle", description: "Settings: name of the Lifecycle section in the settings tab list" },
  backups: { id: "web.routes.tabs.settings.section_scheduled_backups", defaultMessage: "Scheduled backups", description: "Settings: name of the Scheduled backups section in the settings tab list" },
  capture: { id: "web.routes.tabs.settings.section_network_capture", defaultMessage: "Network capture", description: "Settings: name of the Network capture section in the settings tab list" },
  placement: { id: "web.routes.tabs.settings.section_placement", defaultMessage: "Placement", description: "Settings: name of the Placement section in the settings tab list" },
  access: { id: "web.routes.tabs.settings.section_rbac_access", defaultMessage: "RBAC & access", description: "Settings: name of the RBAC and access section in the settings tab list" },
  sharelinks: { id: "web.routes.tabs.settings.section_share_links", defaultMessage: "Share links", description: "Settings: name of the Share links section in the settings tab list" },
  danger: { id: "web.routes.tabs.settings.section_danger_zone", defaultMessage: "Danger zone", description: "Settings: name of the Danger zone section in the settings tab list" },
});

const SECTION_DESCRIPTIONS = defineMessages({
  general: { id: "web.routes.tabs.settings.section_description_general", defaultMessage: "Identity, description, container image and labels.", description: "Settings: one-line description under the General section heading" },
  resources: { id: "web.routes.tabs.settings.section_description_resources", defaultMessage: "CPU, memory and storage reserved for the game container.", description: "Settings: one-line description under the Resources section heading" },
  startup: { id: "web.routes.tabs.settings.section_description_startup", defaultMessage: "How Java launches this server: heap size and extra JVM flags.", description: "Settings: one-line description under the Startup section heading" },
  networking: { id: "web.routes.tabs.settings.section_description_networking", defaultMessage: "Service exposure, tunnels and ports that players connect through.", description: "Settings: one-line description under the Networking section heading" },
  env: { id: "web.routes.tabs.settings.section_description_environment", defaultMessage: "Environment variables passed to the game container.", description: "Settings: one-line description under the Environment section heading" },
  lifecycle: { id: "web.routes.tabs.settings.section_description_lifecycle", defaultMessage: "Auto-restart, graceful shutdown, health probes and idle auto-sleep.", description: "Settings: one-line description under the Lifecycle section heading" },
  backups: { id: "web.routes.tabs.settings.section_description_scheduled_backups", defaultMessage: "Recurring backups of this server's data volume.", description: "Settings: one-line description under the Scheduled backups section heading" },
  capture: { id: "web.routes.tabs.settings.section_description_network_capture", defaultMessage: "Packet capture for debugging connection problems.", description: "Settings: one-line description under the Network capture section heading" },
  placement: { id: "web.routes.tabs.settings.section_description_placement", defaultMessage: "Kubernetes scheduling rules: node tolerations and affinity.", description: "Settings: one-line description under the Placement section heading" },
  access: { id: "web.routes.tabs.settings.section_description_rbac_access", defaultMessage: "The owner and collaborators who can manage this server.", description: "Settings: one-line description under the RBAC and access section heading" },
  danger: { id: "web.routes.tabs.settings.section_description_danger_zone", defaultMessage: "Irreversible actions for this server. Proceed with care.", description: "Settings: one-line description under the Danger zone section heading" },
});

const SECTIONS: Section[] = [
  { key: "general",    label: SECTION_LABELS.general,    icon: SettingsIcon,      framed: true, description: SECTION_DESCRIPTIONS.general },
  { key: "version",    label: SECTION_LABELS.version,    icon: Layers },
  { key: "config",     label: SECTION_LABELS.config,     icon: SlidersHorizontal },
  { key: "startup",    label: SECTION_LABELS.startup,    icon: Rocket,            description: SECTION_DESCRIPTIONS.startup },
  { key: "resources",  label: SECTION_LABELS.resources,  icon: HardDrive,         framed: true, divider: true, description: SECTION_DESCRIPTIONS.resources },
  { key: "networking", label: SECTION_LABELS.networking, icon: Network,           framed: true, description: SECTION_DESCRIPTIONS.networking },
  { key: "env",        label: SECTION_LABELS.env,        icon: Variable,          framed: true, description: SECTION_DESCRIPTIONS.env },
  { key: "lifecycle",  label: SECTION_LABELS.lifecycle,  icon: Sliders,           framed: true, divider: true, description: SECTION_DESCRIPTIONS.lifecycle },
  { key: "backups",    label: SECTION_LABELS.backups,    icon: CalendarClock,     framed: true, description: SECTION_DESCRIPTIONS.backups },
  { key: "capture",    label: SECTION_LABELS.capture,    icon: RadioTower,        framed: true, description: SECTION_DESCRIPTIONS.capture },
  { key: "placement",  label: SECTION_LABELS.placement,  icon: MapPin,            framed: true, description: SECTION_DESCRIPTIONS.placement },
  { key: "access",     label: SECTION_LABELS.access,     icon: ShieldCheck,       divider: true, description: SECTION_DESCRIPTIONS.access },
  { key: "sharelinks", label: SECTION_LABELS.sharelinks, icon: Link2 },
  { key: "danger",     label: SECTION_LABELS.danger,     icon: AlertTriangle,     divider: true, description: SECTION_DESCRIPTIONS.danger },
];

export interface SettingsTabProps {
  gs?: GameServer;
  name: string;
  ns?: string;
  onDirtyChange?: (dirty: boolean) => void;
}

export function SettingsTab({ gs, name, ns, onDirtyChange }: SettingsTabProps) {
  const intl = useOptionalIntl();
  const resourceTarget = useResourceTarget({ name, namespace: ns });
  const access = useResourceAccess();
  const resourceClient = useResourceClient(resourceTarget);
  const { Servers } = resourceClient;
  const qc = useQueryClient();
  const [section, setSection] = useState<SectionKey>("general");
  const [draft, setDraft] = useState<GameServer | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [sectionValidity, setSectionValidity] = useState<Partial<Record<SectionKey, boolean>>>({});
  const [draftRevision, setDraftRevision] = useState(0);
  const savingRef = useRef(false);
  const validityCallbacks = useMemo(() => {
    const report = (key: SectionKey) => (valid: boolean) => {
      if (savingRef.current) return;
      setSectionValidity((previous) => previous[key] === valid ? previous : { ...previous, [key]: valid });
    };
    return { config: report("config"), startup: report("startup"), networking: report("networking"), capture: report("capture"), placement: report("placement") };
  }, []);
  // `dirty` (does draft differ from the last known-good server snapshot) is
  // read directly in JSX, so it's tracked as its own piece of state,
  // recomputed imperatively at every site that mutates `draft` or the
  // baseline. That keeps `baselineRef` a plain ref (safe to read in effects
  // and handlers, never during render) instead of needing its `.current` in
  // a render-time computation.
  const [dirty, setDirty] = useState(false);
  const baselineRef = useRef<GameServer | null>(null);
  // spec.config of the baseline, as state because the Game configuration
  // section reads it during render; it must match what the draft was cloned
  // from, not a newer `gs` that arrived while edits are unsaved.
  const [baselineConfig, setBaselineConfig] = useState<Record<string, string> | undefined>(undefined);
  const lastSeenRef = useRef<GameServer | undefined>(undefined);

  // Initialize / reset the draft whenever a fresh server arrives and
  // the local form has no unsaved edits. We compare against the last gs
  // we processed (not against draft) so this effect only fires on real
  // gs changes, not on draft mutations.
  useEffect(() => {
    if (!gs) return;
    if (gs === lastSeenRef.current) return;
    lastSeenRef.current = gs;
    if (baselineRef.current && draft && isDirty(draft, baselineRef.current)) {
      // Local edits in flight — don't clobber.
      return;
    }
    const clone = structuredClone(gs);
    baselineRef.current = clone;
    setBaselineConfig(clone.spec.config);
    setDraft(clone);
    setConflict(false);
    setDirty(false);
    setSectionValidity({});
    setDraftRevision((revision) => revision + 1);
  }, [gs, draft]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const { data: template } = useQuery({
    queryKey: resourceKey(resourceTarget, "template", draft?.spec.templateRef.name),
    queryFn: ({ signal }) => resourceClient.withSignal(signal).Templates.forServer(draft!.spec.templateRef.name, draft!.metadata.name, draft!.metadata.namespace),
    enabled: !!draft?.spec.templateRef.name,
  });
  const moduleText = useModuleText(draft?.spec.templateRef.name, resourceTarget.cluster);

  // Validate config from the shared draft even when its section is unmounted.
  // Other sections retain their reported validity across navigation, including
  // invalid editor text that has not yet been committed into the draft.
  const draftValid = !!template &&
    validateConfig(template.spec.configSchema ?? [], draft?.spec.config ?? {}, intl).length === 0 &&
    Object.values(sectionValidity).every(Boolean);

  const save = useMutation({
    onMutate: () => { savingRef.current = true; },
    onSettled: () => { savingRef.current = false; },
    mutationFn: async (next: GameServer) => {
      if (!template || validateConfig(template.spec.configSchema ?? [], next.spec.config ?? {}, intl).length > 0 ||
        !Object.values(sectionValidity).every(Boolean)) {
        throw new Error(intl.formatMessage({ id: "web.routes.tabs.settings.correct_invalid_before_saving", defaultMessage: "Correct invalid settings before saving.", description: "Settings: error shown when saving is attempted while some settings are invalid" }));
      }
      // Re-fetch latest to merge edits onto the freshest copy. This
      // keeps fields the UI doesn't model (e.g. operator-managed status,
      // newly-added spec keys) from being clobbered.
      const latest = await Servers.get(name, ns);
      const merged = mergeDraftOntoLatest(next, baselineRef.current!, latest, intl);
      return Servers.update(name, merged, ns);
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ["fleet"] });
      const clone = structuredClone(saved);
      baselineRef.current = clone;
      setBaselineConfig(clone.spec.config);
      setDraft(clone);
      setDirty(false);
      setConflict(false);
      setError(null);
      setSavedAt(Date.now());
      setSectionValidity({});
      setDraftRevision((revision) => revision + 1);
      return qc.invalidateQueries({ queryKey: resourceKey(resourceTarget, "server", name, ns) });
    },
    onError: (err) => {
      if (err instanceof SettingsConflictError || (err instanceof APIError && err.status === 409)) {
        setConflict(true);
        setError(null);
      } else {
        setError(errMsg(err, intl));
      }
    },
  });

  if (!draft) {
    return <div className="p-6 text-sm text-muted">{intl.formatMessage({ id: "web.routes.tabs.settings.loading", defaultMessage: "Loading…", description: "Settings tab: loading text shown while the settings are fetched or a settings section is still loading" })}</div>;
  }

  const reset = () => {
    if (baselineRef.current) {
      setDraft(structuredClone(baselineRef.current));
      setDirty(false);
    }
    setConflict(false);
    setError(null);
    setSectionValidity({});
    setDraftRevision((revision) => revision + 1);
  };

  const reload = async () => {
    try {
      const fresh = await Servers.get(name, ns);
      const clone = structuredClone(fresh);
      baselineRef.current = clone;
      setBaselineConfig(clone.spec.config);
      setDraft(clone);
      setDirty(false);
      setConflict(false);
      setError(null);
      setSectionValidity({});
      setDraftRevision((revision) => revision + 1);
      qc.setQueryData(resourceKey(resourceTarget, "server", name, ns), fresh);
    } catch (err) {
      setError(errMsg(err, intl));
    }
  };

  const onChangeDraft = (next: GameServer) => {
    if (savingRef.current) return;
    setDraft(next);
    setDirty(baselineRef.current ? isDirty(next, baselineRef.current) : false);
    if (savedAt) setSavedAt(null);
  };

  // The Version section only exists for templates with a version catalog;
  // Game configuration only for templates with a configSchema (or when the
  // server still carries config keys that need removing, because the operator
  // rejects unknown keys).
  const sections = SECTIONS.filter((s) => {
    if (s.key === "version") return (template?.spec.versions?.length ?? 0) > 0;
    if (s.key === "startup") return (template?.spec.configSchema ?? []).some((field) => STARTUP_KEYS.includes(field.name));
    if (s.key === "config") {
      return (
        (template?.spec.configSchema?.length ?? 0) > 0 ||
        Object.keys(draft.spec.config ?? {}).length > 0
      );
    }
    return true;
  });
  // Without servers:write the Game configuration section is view-only and the
  // footer shows a note instead of Discard/Save.
  const readOnlyConfig = (section === "config" || section === "startup") && !access?.canWrite;
  const active = SECTIONS.find((s) => s.key === section);

  return (
    <div className="flex h-full">
      <nav className="w-60 shrink-0 overflow-y-auto border-r border-border p-3 scrollbar-thin">
        <Tabs
          selectedKey={section}
          onSelectionChange={(k) => {
            setSection(k as SectionKey);
          }}
          orientation="vertical"
          className="server-settings-nav"
        >
          <Tabs.List aria-label={intl.formatMessage({ id: "web.routes.tabs.settings.settings_sections", defaultMessage: "Settings sections", description: "Settings: accessible label of the list of settings sections; not shown as text" })}>
            {sections.map(({ key, label, icon: Icon, divider }) => (
              <Tabs.Tab
                key={key}
                id={key}
                data-divider={divider || undefined}
                data-danger={key === "danger" || undefined}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{intl.formatMessage(label)}</span>
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Share dialogs own their state independently of the settings draft.
            A status refresh must not discard a newly issued, one-time token. */}
        <fieldset key={section === "sharelinks" ? "sharelinks" : draftRevision} disabled={save.isPending} inert={save.isPending} className="min-w-0 flex-1 overflow-auto border-0 p-6 scrollbar-thin lg:px-10 lg:py-8">
          <div className="max-w-4xl">
            {active?.description && <SectionHeader section={active} />}
            <div className={cn(active?.framed && "rounded-xl border border-border bg-card p-6")}>
              {section === "general"    && <GeneralSection    draft={draft} onChange={onChangeDraft} template={template} />}
              {section === "version"    && <VersionSection    draft={draft} onChange={onChangeDraft} template={template} moduleText={moduleText} />}
              {section === "config"     && <GameConfigSection draft={draft} onChange={onChangeDraft} template={template} moduleText={moduleText} storedConfig={baselineConfig} onValidityChange={validityCallbacks.config} />}
              {section === "startup"    && <StartupSection    draft={draft} onChange={onChangeDraft} template={template} onValidityChange={validityCallbacks.startup} />}
              {section === "resources"  && <ResourcesSection  draft={draft} onChange={onChangeDraft} template={template} />}
              {section === "networking" && <NetworkingSection draft={draft} onChange={onChangeDraft} template={template} onValidityChange={validityCallbacks.networking} />}
              {section === "env"        && <EnvVarsSection    draft={draft} onChange={onChangeDraft} template={template} />}
              {section === "lifecycle"  && <LifecycleSection  draft={draft} onChange={onChangeDraft} template={template} />}
              {section === "backups"    && <BackupsSection    draft={draft} onChange={onChangeDraft} template={template} />}
              {section === "capture"    && <NetworkCaptureSection draft={draft} onChange={onChangeDraft} template={template} onValidityChange={validityCallbacks.capture} />}
              {section === "placement"  && (
                <Suspense fallback={<div className="text-sm text-muted">{intl.formatMessage({ id: "web.routes.tabs.settings.loading", defaultMessage: "Loading…", description: "Settings tab: loading text shown while the settings are fetched or a settings section is still loading" })}</div>}>
                  <PlacementSection
                    draft={draft}
                    onChange={onChangeDraft}
                    template={template}
                    onValidityChange={validityCallbacks.placement}
                  />
                </Suspense>
              )}
              {section === "access"     && <AccessSection     gs={gs} />}
              {section === "sharelinks" && <ShareLinksSection name={name} ns={ns} />}
              {section === "danger"     && <DangerSection     name={name} ns={ns} />}
            </div>
          </div>
        </fieldset>

        {section !== "danger" && section !== "access" && section !== "sharelinks" && (
          <footer className="flex items-center justify-between gap-4 border-t border-border bg-background px-6 py-3 lg:px-10">
            <div className="min-w-0 text-xs">
              {conflict && !error && (
                <span className="text-warning">{intl.formatMessage({ id: "web.routes.tabs.settings.server_changed_since_you_opened_this", defaultMessage: "Server changed since you opened this page.", description: "Settings tab: warning in the footer saying the server changed after the page was opened; followed by a Reload button and the sentence after it" })} <button onClick={() => void reload()} className="underline hover:text-fg">{intl.formatMessage({ id: "web.routes.tabs.settings.reload", defaultMessage: "Reload", description: "Settings tab: inline button in the footer warning that reloads the latest server settings; keep it short" })}</button> {intl.formatMessage({ id: "web.routes.tabs.settings.to_discard_your_edits_and_load_the", defaultMessage: "to discard your edits and load the latest.", description: "Settings tab: sentence after the Reload button in the footer warning, saying reloading discards edits and loads the latest settings" })}</span>
              )}
              {error && (
                <span className="text-danger">
                  {error}
                  {conflict && (
                    <> <button onClick={() => void reload()} className="underline hover:text-fg">{intl.formatMessage({ id: "web.routes.tabs.settings.retry_reload", defaultMessage: "Retry reload", description: "Settings tab: inline button shown after a failed reload that tries the reload again; keep it short" })}</button>
                    </>
                  )}
                </span>
              )}
              {!conflict && !error && dirty && (
                <span className="inline-flex items-center gap-2 text-warning">
                  <span className="h-2 w-2 rounded-full bg-warning" />
                  {intl.formatMessage({ id: "web.routes.tabs.settings.unsaved_changes", defaultMessage: "Unsaved changes", description: "Settings tab: footer status text shown when the settings form has edits that are not saved yet" })}
                </span>
              )}
              {!conflict && !error && !dirty && savedAt && (
                <span className="inline-flex items-center gap-1.5 text-success">
                  <Check className="h-3.5 w-3.5" />
                  {intl.formatMessage({ id: "web.routes.tabs.settings.saved", defaultMessage: "Saved.", description: "Settings tab: footer status text shown briefly after the settings are saved" })}
                </span>
              )}
              {readOnlyConfig && (
                <span className="text-muted">{intl.formatMessage({ id: "web.routes.tabs.settings.you_need_permission_to_change_this", defaultMessage: "You need permission to change this server's settings.", description: "Settings tab: footer text shown to users who can view but not change this server's settings" })}</span>
              )}
            </div>
            {!readOnlyConfig && (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onPress={reset}
                isDisabled={!dirty || save.isPending}
              >{intl.formatMessage({ id: "web.routes.tabs.settings.discard", defaultMessage: "Discard", description: "Settings tab: footer button that throws away unsaved settings edits; disabled when nothing changed; keep it short" })}</Button>
              <Button
                size="sm"
                onPress={() => save.mutate(draft)}
                isDisabled={!access?.canWrite || !dirty || !draftValid || save.isPending}
              >
                {save.isPending
                  ? intl.formatMessage({ id: "web.routes.tabs.settings.saving", defaultMessage: "Saving…", description: "Settings: label of the save button while the save is running" })
                  : intl.formatMessage({ id: "web.routes.tabs.settings.save_changes", defaultMessage: "Save changes", description: "Settings: label of the button that saves the server settings" })}
              </Button>
            </div>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}

function SectionHeader({ section }: { section: Section }) {
  const intl = useOptionalIntl();
  const Icon = section.icon;
  return (
    <div className="flex items-start gap-3 pb-6">
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          section.key === "danger" ? "bg-danger/10 text-danger" : "bg-primary/10 text-primary",
        )}
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold leading-tight text-fg">{intl.formatMessage(section.label)}</h2>
        <p className="pt-1 text-[13px] text-muted">{section.description && intl.formatMessage(section.description)}</p>
      </div>
    </div>
  );
}

function isDirty(a: GameServer, b: GameServer): boolean {
  return JSON.stringify(serializeForDiff(a)) !== JSON.stringify(serializeForDiff(b));
}

// Strip status + resourceVersion before diffing so server-side updates
// (heartbeats, conditions) don't mark the form as dirty.
function serializeForDiff(gs: GameServer) {
  const meta = { ...gs.metadata };
  delete meta.resourceVersion;
  return { metadata: meta, spec: gs.spec };
}

function errMsg(err: unknown, intl: IntlShape): string {
  return errorTextIntl(intl, err, intl.formatMessage({ id: "web.routes.tabs.settings.save_failed", defaultMessage: "save failed", description: "Settings: error shown when saving the server settings fails and the error has no message" }));
}
