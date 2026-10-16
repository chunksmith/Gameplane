import { lazy, Suspense, useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Tab, Tabs } from "@heroui/react";
import {
  AlertTriangle,
  Archive,
  FolderOpen,
  History,
  LayoutDashboard,
  Loader2,
  Package,
  Play,
  Puzzle,
  RadioTower,
  RotateCw,
  ScrollText,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  Sunrise,
  Terminal,
  Users,
  type LucideIcon,
} from "lucide-react";
import { createResourceClient, type LifecycleVerb } from "@/lib/endpoints";
import { useGameCodes } from "@/lib/useGameCodes";
import { resolveConsoleMode, serverHasMods, serverHasModpacks } from "@/lib/capabilities";
import { useMe } from "@/lib/auth";
import { useAssistantStatus } from "@/lib/assistant";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { PhaseChip } from "@/components/ui/PhaseChip";
import { GameIcon } from "@/components/ui/GameIcon";
import { capitalize, formatUptime, ignoreRejection } from "@/lib/utils";
import { ServerActionsMenu } from "@/components/server/ServerActionsMenu";
import { CaptureWidget } from "@/components/CaptureWidget";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { ResourceTargetProvider, useResourceClient, useResourceTarget, useResourceAccess, resourceCan, resourceKey, type ResourceTarget, type ServerAccessResponse } from "@/lib/resourceTarget";
import { createRequestClient } from "@/lib/api";
import { DEFAULT_NAMESPACE } from "@/lib/cluster";
import { ErrorCard } from "@/components/ui/ErrorCard";
import { LoadingCard } from "@/components/ui/LoadingCard";

import { OverviewTab } from "./tabs/Overview";
import { EventsTab } from "./tabs/Events";
import { LogsTab } from "./tabs/Logs";
import { ModsTab } from "./tabs/Mods";
import { ModpacksTab } from "./tabs/Modpacks";
import { PlayersTab } from "./tabs/Players";
import { BackupsTab } from "./tabs/Backups";
import { SettingsTab } from "./tabs/Settings";

// Console (xterm) and Files (Monaco) bring in heavy vendor deps; load on demand.
const ConsoleTab = lazy(() =>
  import("./tabs/Console").then((m) => ({ default: m.ConsoleTab })),
);
const FilesTab = lazy(() =>
  import("./tabs/Files").then((m) => ({ default: m.FilesTab })),
);

type TabKey =
  | "overview" | "assistant" | "events" | "console" | "logs" | "files" | "mods" | "modpacks" | "players" | "backups" | "capture" | "settings";

const tabs: Array<{ key: TabKey; label: string; icon: LucideIcon }> = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "assistant", label: "Assistant", icon: Sparkles },
  { key: "events",   label: "Events",   icon: History },
  { key: "console",  label: "Console",  icon: Terminal },
  { key: "logs",     label: "Logs",     icon: ScrollText },
  { key: "files",    label: "Files",    icon: FolderOpen },
  { key: "mods",     label: "Mods",     icon: Puzzle },
  { key: "modpacks", label: "Modpacks", icon: Package },
  { key: "players",  label: "Players",  icon: Users },
  { key: "backups",  label: "Backups",  icon: Archive },
  { key: "capture",  label: "Capture",  icon: RadioTower },
  { key: "settings", label: "Settings", icon: SettingsIcon },
];

export function ServerDetailPage() {
  const { name } = useParams({ from: "/app-layout/servers/$name" });
  const { ns = DEFAULT_NAMESPACE, cluster = "local" } = useSearch({ from: "/app-layout/servers/$name" });
  return <ResolveServerDetail key={JSON.stringify([cluster, ns, name])} target={{ cluster, namespace: ns, name }} />;
}

function ResolveServerDetail({ target }: { target: ResourceTarget }) {
  const server = useQuery({
    queryKey: resourceKey(target, "server"),
    queryFn: ({ signal }) => createResourceClient(target, signal).Servers.get(target.name, target.namespace),
  });
  const resolved = { ...target, namespace: server.data?.metadata.namespace ?? target.namespace, uid: server.data?.metadata.uid };
  const access = useQuery({
    queryKey: resourceKey(resolved, "access"),
    queryFn: ({ signal }) => createRequestClient(resolved, signal).api<ServerAccessResponse>(
      `/servers/${encodeURIComponent(target.name)}/access`,
    ),
    enabled: !!server.data,
  });
  const retry = () => { void server.refetch(); void access.refetch(); };
  if (server.error || access.error) return <div className="p-6"><ErrorCard message="This server could not be loaded at its recorded location. Check your access and the site's connection." onRetry={retry} /></div>;
  if (!server.data || !access.data) return <div className="p-6"><LoadingCard message="Loading server…" /></div>;
  const authorized = access.data.target;
  if (authorized.cluster !== resolved.cluster || authorized.namespace !== resolved.namespace || authorized.name !== resolved.name || (resolved.uid && authorized.uid !== resolved.uid)) {
    return <div className="p-6"><ErrorCard message="This server changed while it was being loaded. Reload its current identity before continuing." onRetry={retry} /></div>;
  }
  return (
    <ResourceTargetProvider target={resolved} access={access.data}>
      <ServerDetailView key={JSON.stringify(resourceKey(resolved))} lookupTarget={target} />
    </ResourceTargetProvider>
  );
}

function ServerDetailView({ lookupTarget }: { lookupTarget: ResourceTarget }) {
  const target = useResourceTarget(lookupTarget);
  const clusterId = target.cluster;
  const name = target.name;
  const ns = target.namespace;
  const client = useResourceClient();
  const { Servers } = client;
  const access = useResourceAccess();
  const [tab, setTab] = useState<TabKey>("overview");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data: me } = useMe();
  const assistant = useAssistantStatus();
  const { _splat: filesSplat } = useParams({ strict: false });
  const filesPath = filesSplat === undefined ? null : `/${filesSplat}`;
  const activeTab = filesPath === null ? tab : "files";

  function openFiles(path: string) {
    void nav({ to: "/servers/$name/files/$", params: { name, _splat: path.replace(/^\/+/, "") }, search: true });
  }

  function selectTab(key: TabKey) {
    if (key === "files") return openFiles("/");
    setTab(key);
    if (filesPath !== null) void nav({ to: "/servers/$name", params: { name }, search: true });
  }

  const { data: gs } = useQuery({
    queryKey: resourceKey(lookupTarget, "server"),
    queryFn: ({ signal }) => client.withSignal(signal).Servers.get(name, ns),
    refetchInterval: settingsDirty ? false : 5_000,
  });

  const templateName = gs?.spec.templateRef.name;
  const { data: tmpl } = useQuery({
    queryKey: resourceKey(target, "template", templateName),
    queryFn: ({ signal }) => client.withSignal(signal).Templates.forServer(templateName as string, name, ns),
    enabled: !!templateName,
  });

  const { gameCodes } = useGameCodes(clusterId);

  const act = useMutation({
    mutationFn: (verb: LifecycleVerb) => Servers.lifecycle(name, verb, ns, clusterId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: resourceKey(lookupTarget, "server") });
      await qc.invalidateQueries({ queryKey: ["fleet"] });
    },
  });

  const phase = gs?.status?.phase;
  // The operator's derivePhase reports Stopping (not Suspended) for the
  // whole graceful-drain window even after status.idle.asleep flips true —
  // players may still be connected. Excluding Stopping keeps the badge
  // honest and keeps the Wake button from appearing on a server that is
  // still shutting down, not actually asleep yet.
  const asleep = gs?.status?.idle?.asleep === true && phase !== "Stopping";
  const running = phase === "Running";
  // While provisioning, the operator refines the Progressing condition
  // with what the pod is doing (pulling image, installing server files,
  // waiting for the agent) — surface it under the phase badge.
  const provisioning = phase === "Starting" || phase === "Pending";
  const progressMessage = gs?.status?.conditions?.find(
    (c) => c.type === "Progressing",
  )?.message;
  // When startup terminally fails the operator sets phase=Failed and puts
  // the reason on the Ready condition (image pull, crash-loop, exit). Both
  // the operator's escalation and a build-error setPhase write Ready, so
  // read the failure message from there.
  const failed = phase === "Failed";
  const failureMessage = gs?.status?.conditions?.find(
    (c) => c.type === "Ready",
  )?.message;
  // Gate lifecycle actions on phase so they aren't fired during a
  // transition (Starting/Stopping/Pending): Start only from a stopped
  // state, Stop/Restart only while Running. act.isPending blocks
  // duplicate mutations from a double-click. When asleep, Start is a silent
  // no-op (spec.suspend is already false) — only :wake clears the operator's
  // sleep marker.
  const canStart = (phase === "Stopped" || phase === "Suspended" || phase === "Failed") && !asleep;
  const version = gs?.status?.agent?.gameVersion;
  const uptime = formatUptime(gs?.status?.startedAt);

  // Tab visibility is driven by the template: a game with no console
  // (consoleMode none / no RCON) hides the Console tab. Logs is always
  // available — the tab streams the container's stdout (install/startup
  // output) via the pod-log API, which needs no logPath; the configured
  // game-log file is just an extra source the tab offers when logPath is
  // set. While the template is still loading we show everything.
  const consoleAvailable = !!access?.canConsole && (!tmpl || resolveConsoleMode(tmpl) !== "none");
  // Mods only appears when this server actually has a mod directory — the
  // template declares the capability AND (for the per-loader model) the
  // active version's loader maps to one. Hidden for e.g. vanilla servers.
  const modsAvailable = serverHasMods(tmpl, gs);
  // Modpacks appears when the template offers modpacks AND the active
  // version's loader can run one — hidden for vanilla and plugin loaders
  // (e.g. Paper), which can't load a Modrinth/Forge modpack.
  const modpacksAvailable = serverHasModpacks(tmpl, gs);
  // Hide Capture only on a confirmed denial. While /users/me is loading or
  // after it failed, permissions are unknown: keep the tab reachable so the
  // widget can show its checking / identity-unavailable (retry) state, with
  // the capture controls still closed.
  const captureTabVisible = !me || resourceCan(access?.permissions ?? [], "captures:manage");
  const visibleTabs = tabs.filter((t) => {
    if (t.key === "assistant") return assistant.data?.enabled === true;
    if (t.key === "console") return consoleAvailable;
    if (t.key === "mods") return modsAvailable;
    if (t.key === "modpacks") return modpacksAvailable;
    if (t.key === "capture") return captureTabVisible;
    if (t.key === "backups") return !gs?.spec.storage?.ephemeral;
    return true;
  });

  // If the active tab gets hidden once the template resolves, fall back
  // to Overview so the content area never goes blank. Adjusted directly
  // during render (not in an effect) — "overview" is always visible, so
  // this can't loop.
  if (!visibleTabs.some((t) => t.key === tab)) setTab("overview");

  // A freshly-created server is provisioning — land the user on Logs so
  // they can watch the install stream, rather than an empty Overview.
  // "Never been Running" = Pending/Starting with no startedAt (the
  // operator sets startedAt only on first reaching Running). Fires once,
  // after gs first loads, and never fights a manual tab click. Adjusted
  // directly during render (not in an effect), gated on autoTabApplied.
  const [autoTabApplied, setAutoTabApplied] = useState(false);
  if (!autoTabApplied && gs) {
    setAutoTabApplied(true);
    const st = gs.status;
    if ((st?.phase === "Pending" || st?.phase === "Starting") && !st.startedAt) {
      setTab("logs");
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border bg-background px-6 pt-8">
        <div className="flex flex-wrap items-start justify-between gap-4 pb-6">
          <div className="flex items-start gap-4">
            <GameIcon
              game={gs?.spec.templateRef.name}
              icon={tmpl?.spec.icon}
              code={gameCodes.get(gs?.spec.templateRef.name ?? "")}
              accentColor={tmpl?.spec.accentColor}
              size="lg"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="truncate font-mono text-2xl font-semibold text-foreground">{name}</h1>
                <PhaseChip phase={phase} asleep={asleep} />
              </div>
              {provisioning && progressMessage && (
                <div className="pt-1 flex items-center gap-1.5 text-xs text-warning">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>{capitalize(progressMessage)}</span>
                </div>
              )}
              {failed && (
                <div className="pt-1 flex items-center gap-1.5 text-xs text-danger">
                  <AlertTriangle className="h-3 w-3" />
                  <span>
                    {failureMessage ? capitalize(failureMessage) : "The server failed to start."}
                  </span>
                </div>
              )}
              <div className="pt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>site: {target.cluster}</span><Dot />
                {gs?.spec.templateRef.name && <span>{gs.spec.templateRef.name}</span>}
                {version && <Dot />}{version && <span>{version}</span>}
                {gs?.metadata.namespace && <><Dot /><span>ns: {gs.metadata.namespace}</span></>}
                {uptime !== "—" && <><Dot /><span>up {uptime}</span></>}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="rounded-full"
              onPress={() => act.mutate("restart")}
              isDisabled={!access?.canControl || !running || act.isPending}
            >
              <RotateCw className="h-4 w-4" /> Restart
            </Button>
            <Button
              variant="outline"
              className="rounded-full"
              onPress={() => act.mutate("stop")}
              isDisabled={!access?.canControl || (!running && !asleep) || act.isPending}
            >
              <Square className="h-4 w-4" /> Stop
            </Button>
            {asleep && (
              <Button
                variant="primary"
                className="rounded-full"
                onPress={() => act.mutate("wake")}
                isDisabled={!access?.canControl || act.isPending}
              >
                <Sunrise className="h-4 w-4" /> Wake
              </Button>
            )}
            {canStart && (
              <Button
                variant="outline"
                className="rounded-full"
                onPress={() => act.mutate("start")}
                isDisabled={act.isPending}
              >
                <Play className="h-4 w-4" /> Start
              </Button>
            )}
            {gs && (
              <ServerActionsMenu
                gs={gs}
                onDeleted={() => ignoreRejection(nav({ to: "/servers" }))}
              />
            )}
          </div>
        </div>

        {act.error && (
          <div className="pb-4">
            <ErrorBanner err={act.error} onDismiss={() => act.reset()} />
          </div>
        )}

        <nav className="-mb-px overflow-x-auto scrollbar-thin">
          <Tabs
            selectedKey={activeTab}
            onSelectionChange={(key) => selectTab(key as TabKey)}
            className="server-detail-tabs"
          >
            <Tabs.List aria-label="Server detail tabs">
              {visibleTabs.map(({ key, label, icon: Icon }) => (
                <Tab key={key} id={key}>
                  <Icon className="h-4 w-4" />
                  {label}
                  <Tabs.Indicator />
                </Tab>
              ))}
            </Tabs.List>
          </Tabs>
        </nav>
      </header>

      <div className="flex-1 overflow-auto scrollbar-thin">
        <Suspense fallback={<TabFallback />}>
          {activeTab === "overview" && (
            <OverviewTab
              gs={gs}
              name={name}
              tmpl={tmpl}
              ns={ns}
              onViewAllEvents={() => setTab("events")}
              onOpenConsole={consoleAvailable ? () => setTab("console") : undefined}
            />
          )}
          {activeTab === "assistant" && (
            <div className="p-4 sm:p-6">
              <AssistantPanel scope={{ server: name, namespace: ns, cluster: clusterId }} />
            </div>
          )}
          {activeTab === "events"   && <EventsTab name={name} ns={ns} gs={gs} />}
          {activeTab === "console"  && <ConsoleTab name={name} ns={ns} />}
          {activeTab === "logs"     && (
            <LogsTab
              name={name}
              ns={ns}
              logPath={tmpl?.spec.logPath}
              phase={phase}
              progressMessage={progressMessage}
            />
          )}
          {activeTab === "files"    && <FilesTab   name={name} ns={ns} path={filesPath ?? "/"} onNavigate={openFiles} />}
          {activeTab === "mods"     && <ModsTab    name={name} ns={ns} tmpl={tmpl} gs={gs} />}
          {activeTab === "modpacks" && <ModpacksTab name={name} ns={ns} tmpl={tmpl} />}
          {activeTab === "players"  && <PlayersTab name={name} ns={ns} tmpl={tmpl} />}
          {activeTab === "backups"  && <BackupsTab name={name} ns={ns} />}
          {activeTab === "capture"  && <CaptureWidget name={name} ns={ns} gs={gs} />}
          {activeTab === "settings" && (
            <SettingsTab gs={gs} name={name} ns={ns} onDirtyChange={setSettingsDirty} />
          )}
        </Suspense>
      </div>
    </div>
  );
}

function Dot() {
  return <span className="text-muted/50">·</span>;
}

function TabFallback() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted">
      Loading…
    </div>
  );
}
