import { useMemo, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, ArrowRight, Check, ExternalLink, Loader2, Megaphone, X } from "lucide-react";
import { Button, Input, Alert, Select, Label, ListBox, ListBoxItem } from "@heroui/react";
import { GameIcon } from "@/components/ui/GameIcon";
import { ResourceInput } from "@/components/ui/ResourceInput";
import { PortOverridesEditor } from "@/components/server/PortOverridesEditor";
import { ConfigFields } from "@/components/server/ConfigFields";
import { assignGameCodesForTemplates } from "@/lib/gameIcon";
import { useFleetPlacements, type FleetPlacement } from "@/lib/fleet";
import { serverLink } from "@/lib/resourceTarget";
import { LoadingCard } from "@/components/ui/LoadingCard";
import { ErrorCard } from "@/components/ui/ErrorCard";
import { APIError } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { createResourceClient, type ServerCreate } from "@/lib/endpoints";
import {
  defaultVersionId,
  isValidK8sName,
  isValidQuantity,
  isValidVersion,
  maskPasswordConfig,
  validateConfig,
} from "@/lib/validation";
import { parseCpuQuantity, cpuCores, parseMemQuantity, memBytes } from "@/lib/quantity";
import { cn, ignoreRejection } from "@/lib/utils";
import { resolveCategories, categoryFilters, matchesCategory } from "@/lib/games";
import type { GameTemplate, PortOverride, GameServerTunnel } from "@/types";


// Wizard steps are derived per-template: the "version" step only appears when
// the template declares a version catalog (spec.versions). Templates without
// one keep the original 4-step flow.
type StepKey = "template" | "version" | "configure" | "network" | "review";
const STEP_TITLES: Record<StepKey, string> = {
  template: "Template",
  version: "Version",
  configure: "Configure",
  network: "Network",
  review: "Review",
};

const DOCS_CREATE_SERVER_URL = "https://gameplanepanel.github.io/website/docs/getting-started";

function stepsFor(template: GameTemplate | null): StepKey[] {
  const base: StepKey[] = ["template", "configure", "network", "review"];
  if ((template?.spec.versions?.length ?? 0) > 0) base.splice(1, 0, "version");
  return base;
}

interface WizardState {
  name: string;
  description: string;
  template: GameTemplate | null;
  version: string;
  config: Record<string, string>;
  cpuLimit: string;
  memoryLimit: string;
  storageSize: string;
  nodePlacement: "auto" | "pin" | "gpu";
  expose: "ClusterIP" | "NodePort" | "LoadBalancer";
  hostname: string;
  sourceRanges: string;
  portOverrides: PortOverride[];
  tunnelEnabled: boolean;
  tunnelProvider: "frp" | "tailscale" | "playit";
  tunnelCredentialsValue: string;
  tunnelCredentialsSecretName: string;
  frpServerAddr: string;
  frpServerPort: string;
  frpRemotePortMappings: Array<{ name: string; remotePort: number }>;
  tailscaleHostname: string;
  tailscaleTags: string;
  playitTunnelName: string;
  addressPool: string;
  requestedAddress: string;
  mode: "single" | "group";
  replicas: string;
  nodes: string[];
  ephemeral: boolean;
  image: string;
}

const initial: WizardState = {
  name: "", description: "",
  template: null, version: "", config: {},
  cpuLimit: "2", memoryLimit: "4Gi",
  storageSize: "20Gi", nodePlacement: "auto",
  expose: "NodePort", hostname: "", sourceRanges: "",
  portOverrides: [],
  tunnelEnabled: false, tunnelProvider: "frp",
  tunnelCredentialsValue: "",
  tunnelCredentialsSecretName: "",
  frpServerAddr: "",
  frpServerPort: "7000",
  frpRemotePortMappings: [],
  tailscaleHostname: "",
  tailscaleTags: "",
  playitTunnelName: "",
  addressPool: "",
  requestedAddress: "",
  mode: "single", replicas: "3", nodes: [], ephemeral: false, image: "",
};

// Largest single-node capacity from the cluster view — the ceiling a pod
// can ever be scheduled onto. Returns 0 when node data is unavailable
// (non-admin / not loaded), which the UI treats as "no cap".
export function nodeCaps(nodes: { cpu?: { capacity?: number }; memory?: { capacity?: number } }[]) {
  const maxCpu = nodes.reduce((m, n) => Math.max(m, n.cpu?.capacity ?? 0), 0);
  const maxMemBytes = nodes.reduce((m, n) => Math.max(m, n.memory?.capacity ?? 0), 0);
  return { maxCpu, maxMemGi: Math.floor(maxMemBytes / 1024 ** 3) };
}

// Split the CIDR allow-list textarea (newline- or comma-separated) into a
// clean list, dropping blanks.
export function parseSourceRanges(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Drop rows whose port name is blank (an untouched "Add override" row) so an
// abandoned editor never pollutes the create payload.
export function nonEmptyPortOverrides(overrides: PortOverride[]): PortOverride[] {
  return overrides.filter((p) => p.name.trim() !== "");
}

// Drop rows whose name is blank or port is invalid (0 or unset) so an
// incomplete mapping never pollutes the tunnel config payload.
export function nonEmptyTunnelPortMappings(
  mappings: Array<{ name: string; remotePort: number }>,
): Array<{ name: string; remotePort: number }> {
  return mappings.filter((m) => m.name.trim() && m.remotePort && m.remotePort > 0);
}

function buildCreateBody(state: WizardState): ServerCreate {
  let nodeSelector: Record<string, string> | undefined;
  if (state.nodePlacement === "pin") nodeSelector = { "gameplane.local/pinned": "true" };
  else if (state.nodePlacement === "gpu") nodeSelector = { "gameplane.local/gpu": "true" };

  let tunnel: GameServerTunnel | undefined;
  if (state.tunnelEnabled) {
    // Determine credentialsSecretRef: either an existing secret name (GitOps) or
    // a deterministic name derived from the server name (for new credentials).
    // The handler creates the Secret at <serverName>-tunnel-auth and the operator
    // mounts it with Optional: true, so the ref can point to a Secret that doesn't
    // yet exist at create time.
    let credentialsSecretRef: { name: string } | undefined;
    if (state.tunnelCredentialsSecretName.trim()) {
      credentialsSecretRef = { name: state.tunnelCredentialsSecretName };
    } else if (state.tunnelCredentialsValue.trim()) {
      credentialsSecretRef = { name: `${state.name}-tunnel-auth` };
    }

    const tunnelBase: GameServerTunnel = {
      enabled: true,
      provider: state.tunnelProvider,
      ...(credentialsSecretRef ? { credentialsSecretRef } : {}),
    };

    if (state.tunnelProvider === "frp") {
      tunnelBase.frp = {
        serverAddr: state.frpServerAddr,
        ...(state.frpServerPort && state.frpServerPort !== "0"
          ? { serverPort: parseInt(state.frpServerPort, 10) }
          : {}),
        remotePorts: nonEmptyTunnelPortMappings(state.frpRemotePortMappings),
      };
    } else if (state.tunnelProvider === "tailscale") {
      tunnelBase.tailscale = {
        ...(state.tailscaleHostname ? { hostname: state.tailscaleHostname } : {}),
        ...(state.tailscaleTags
          ? { tags: state.tailscaleTags.split(/[\s,]+/).filter(Boolean) }
          : {}),
      };
    } else if (state.tunnelProvider === "playit") {
      tunnelBase.playit = {
        ...(state.playitTunnelName ? { tunnelName: state.playitTunnelName } : {}),
      };
    }
    // tunnelBase always carries `provider` alongside `enabled`, so it is
    // never just `{ enabled: true }` — include it whenever the wizard step
    // is enabled.
    tunnel = tunnelBase;
  }

  return {
    name: state.name,
    description: state.description || undefined,
    templateRef: { name: state.template!.metadata.name },
    ...(state.version ? { version: state.version } : {}),
    ...(state.image.trim() ? { image: state.image.trim() } : {}),
    config: state.config,
    storage: state.ephemeral ? { ephemeral: true } : { size: state.storageSize },
    networking: {
      expose: state.expose,
      hostname: state.hostname || undefined,
      // Only included when at least one override names a template port.
      ...(nonEmptyPortOverrides(state.portOverrides).length > 0
        ? { portOverrides: nonEmptyPortOverrides(state.portOverrides) }
        : {}),
      // Only meaningful for LoadBalancer; omit otherwise so we don't store a
      // range the operator would ignore.
      ...(state.expose === "LoadBalancer" && parseSourceRanges(state.sourceRanges).length > 0
        ? { sourceRanges: parseSourceRanges(state.sourceRanges) }
        : {}),
      // Load-balancer address pool preference; omit when empty so we don't store
      // a preference the operator would ignore (absent = no pool selection).
      ...(state.addressPool.trim() ? { addressPool: state.addressPool.trim() } : {}),
      // Specific IP to request from the pool; omit when empty.
      ...(state.requestedAddress.trim() ? { address: state.requestedAddress.trim() } : {}),
      ...(tunnel ? { tunnel } : {}),
    },
    resources: {
      // The create form uses Guaranteed QoS: requests == limits, so the pod
      // is scheduled onto (and kept on) a node that can always give it the
      // full amount, and never gets OOM-killed or CPU-throttled below what
      // was configured.
      requests: { cpu: state.cpuLimit, memory: state.memoryLimit },
      limits: { cpu: state.cpuLimit, memory: state.memoryLimit },
    },
    ...(nodeSelector && state.mode === "single" ? { nodeSelector } : {}),
  };
}

type StepCheck = { ok: true } | { ok: false; reason: string };

// caps bounds the resource inputs to the largest single node; {0,0} means
// node data is unavailable (non-admin / not loaded) and no cap is applied.
function validateStep(
  key: StepKey,
  state: WizardState,
  caps: { maxCpu: number; maxMemGi: number } = { maxCpu: 0, maxMemGi: 0 },
): StepCheck {
  if (key === "template") {
    return state.template ? { ok: true } : { ok: false, reason: "Pick a game template to continue" };
  }
  if (key === "version") {
    return isValidVersion(state.template ?? undefined, state.version)
      ? { ok: true }
      : { ok: false, reason: "Choose a version to continue" };
  }
  if (key === "configure") {
    if (!isValidK8sName(state.name)) {
      return {
        ok: false,
        reason: state.name
          ? "Name must be lowercase letters, digits, dashes (max 63)"
          : "Server name is required",
      };
    }
    if (state.mode === "group" && state.name.length > 40) {
      return { ok: false, reason: "Group name must be at most 40 characters" };
    }
    if (state.mode === "group") {
      const replicas = Number(state.replicas);
      if (!Number.isInteger(replicas) || replicas < 1 || replicas > 100) {
        return { ok: false, reason: "Replicas must be a whole number from 1 to 100" };
      }
    }
    if (!state.ephemeral && !isValidQuantity(state.storageSize)) {
      return { ok: false, reason: "Storage must be a Kubernetes quantity (e.g. 50Gi)" };
    }
    if (!isValidQuantity(state.cpuLimit) || !isValidQuantity(state.memoryLimit)) {
      return { ok: false, reason: "CPU and memory must be valid quantities" };
    }
    const cpuParsed = parseCpuQuantity(state.cpuLimit);
    if (caps.maxCpu > 0 && cpuParsed && cpuCores(cpuParsed) > caps.maxCpu) {
      return { ok: false, reason: `CPU can't exceed ${caps.maxCpu} cores — no single node has more` };
    }
    const memParsed = parseMemQuantity(state.memoryLimit);
    if (caps.maxMemGi > 0 && memParsed && memBytes(memParsed) / 1024 ** 3 > caps.maxMemGi) {
      return { ok: false, reason: `Memory can't exceed ${caps.maxMemGi} GiB — no single node has more` };
    }
    const cfgErrors = validateConfig(state.template?.spec.configSchema ?? [], state.config);
    if (cfgErrors.length > 0) {
      return { ok: false, reason: cfgErrors[0].message };
    }
    return { ok: true };
  }
  if (key === "network") {
    if (state.mode === "group" && state.tunnelEnabled) {
      return { ok: false, reason: "Tunnels aren't supported for server groups" };
    }
    if (state.mode === "group" && state.requestedAddress.trim()) {
      return { ok: false, reason: "A fixed address can't be shared by a server group" };
    }
    if (state.tunnelEnabled) {
      // Tunnel requires either a credential value (new) or existing secret name (GitOps).
      if (!state.tunnelCredentialsValue.trim() && !state.tunnelCredentialsSecretName.trim()) {
        return { ok: false, reason: "Tunnel requires credentials (enter value or existing secret name)" };
      }
      if (state.tunnelProvider === "frp") {
        if (!state.frpServerAddr.trim()) {
          return { ok: false, reason: "frp requires a server address" };
        }
        // Filter out empty mappings and check that at least one remains
        const nonEmptyMappings = state.frpRemotePortMappings.filter(
          (m) => m.name.trim() && m.remotePort && m.remotePort > 0,
        );
        if (nonEmptyMappings.length === 0) {
          return { ok: false, reason: "frp requires at least one complete port mapping" };
        }
        // Validate port numbers are in valid range
        for (const mapping of nonEmptyMappings) {
          const port = mapping.remotePort;
          if (port < 1 || port > 65535) {
            return { ok: false, reason: "Port numbers must be between 1 and 65535" };
          }
        }
        if (state.frpServerPort) {
          const serverPort = parseInt(state.frpServerPort, 10);
          if (isNaN(serverPort) || serverPort < 1 || serverPort > 65535) {
            return { ok: false, reason: "Server port must be between 1 and 65535" };
          }
        }
      }
    }
    return { ok: true };
  }
  return { ok: true };
}

function errorMessage(err: unknown, name: string): { title: string; body: string } {
  if (err instanceof APIError) {
    if (err.status === 409) {
      return {
        title: `A server named ${name} already exists`,
        body: "Pick a different name, or open the existing server. Names must be unique inside the namespace.",
      };
    }
    if (err.status === 403) {
      return {
        title: "Not permitted",
        body: err.body.slice(0, 240) || "Your role does not allow creating servers in this namespace.",
      };
    }
    return {
      title: `Create failed (${err.status})`,
      body: err.body.slice(0, 240) || "The API rejected the request.",
    };
  }
  return {
    title: "Create failed",
    body: errorText(err, "Unknown error"),
  };
}

export function CreateServerWizard() {
  const search = useSearch({ from: "/app-layout/servers/new" });
  const placements = useFleetPlacements();
  const [selected, setSelected] = useState<string>();
  const choices = placements.data?.items ?? [];
  const key = (p: FleetPlacement) => JSON.stringify([p.cluster, p.namespace]);
  const requested = choices.filter((p) => (!search.cluster || p.cluster === search.cluster) && (!search.ns || p.namespace === search.ns));
  const placement = selected ? choices.find((p) => key(p) === selected) : requested.find((p) => p.cluster === "local") ?? requested[0];
  if (!selected && placement) setSelected(key(placement));
  if (placements.isPending) return <LoadingCard message="Finding available locations…" />;
  if (placements.error) return <ErrorCard title="Locations unavailable" message="Unable to load authorized server locations." onRetry={() => void placements.refetch()} />;
  if (!placement) return <ErrorCard title="No available location" message="The selected location is unavailable or no reachable location permits creation. Restore its access or return to the server list to choose an available location." />;
  return <PlacedServerWizard key={key(placement)} placement={placement} choices={choices} onPlacementChange={setSelected} partial={placements.data?.partial === true} />;
}

function PlacedServerWizard({ placement, choices, onPlacementChange, partial }: {
  placement: FleetPlacement; choices: FleetPlacement[]; onPlacementChange: (key: string) => void; partial: boolean;
}) {
  const clusterId = placement.cluster;
  const namespace = placement.namespace;
  const client = useMemo(() => createResourceClient({ cluster: clusterId, namespace }), [clusterId, namespace]);
  const { Servers, ServerSets } = client;
  const [stepIndex, setStepIndex] = useState(0);
  const [state, setState] = useState<WizardState>(initial);
  const nav = useNavigate();
  const qc = useQueryClient();
  // Cancel/Close just leave the wizard; a rejected navigation (e.g. the
  // route change was interrupted) has nothing useful to show, but must not
  // become an unhandled promise rejection.
  const closeWizard = () => ignoreRejection(nav({ to: "/servers" }));

  // When arriving from the Modules catalog "Deploy" action
  // (/servers/new?template=<name>), pre-select that template once the list
  // loads. One-shot, so manual changes afterwards aren't clobbered.
  const search = useSearch({ from: "/app-layout/servers/new" });
  const templates = { items: placement.templates };
  const gameCodes = useMemo(() => assignGameCodesForTemplates(placement.templates), [placement.templates]);
  const byName = useMemo(() => new Map(placement.templates.map((t) => [t.metadata.name, t])), [placement.templates]);
  const [presetApplied, setPresetApplied] = useState(false);
  // Adjusted directly during render (not in an effect): re-checks on every
  // render until a match is found (templates may still be loading, or the
  // list may not include the requested name yet), but only calls setState
  // — flipping presetApplied, which stops the check — once it actually
  // finds one.
  if (!presetApplied && search.template && templates) {
    const match = templates.items.find((t) => t.metadata.name === search.template);
    if (match) {
      setPresetApplied(true);
      setState((s) => ({ ...s, template: match, config: {}, version: defaultVersionId(match) ?? "" }));
    }
  }

  const create = useMutation({
    mutationFn: async () => {
      if (state.mode === "group") {
        await ServerSets.create({ ...buildCreateBody(state), replicas: Number(state.replicas), ...(state.nodes.length ? { nodes: state.nodes } : {}) });
        return null;
      }
      const server = await Servers.create(buildCreateBody(state));

      // If tunnel is enabled and credential value was provided, save credentials after server creation.
      if (state.tunnelEnabled && state.tunnelCredentialsValue.trim() && !state.tunnelCredentialsSecretName.trim()) {
        const key =
          state.tunnelProvider === "frp"
            ? "token"
            : state.tunnelProvider === "tailscale"
              ? "authKey"
              : "secretKey";
        try {
          await Servers.setTunnelCredentials(state.name, state.tunnelProvider, { [key]: state.tunnelCredentialsValue }, placement.namespace);
        } catch (err) {
          // Server was created with tunnel enabled and a ref to the secret, but the credential
          // save (Secret creation) failed. Tell the user the server exists and how to retry.
          const detail = errorText(err, String(err));
          throw new Error(
            `Server created but credential save failed: ${detail}. ` +
            `The server exists with tunnel enabled. You can set the credential from the server's Networking settings.`,
            { cause: err }
          );
        }
      }

      return server;
    },
    onSuccess: async (server) => {
      await qc.invalidateQueries({ queryKey: ["fleet"] });
      if (!server) {
        await nav({ to: "/servers" });
        return;
      }
      await nav(serverLink({ cluster: placement.cluster, namespace: server.metadata.namespace ?? placement.namespace, name: server.metadata.name }));
    },
  });

  const steps = stepsFor(state.template);
  const currentKey: StepKey = steps[stepIndex] ?? "template";
  const isLast = stepIndex === steps.length - 1;
  // Resource ceilings from the cluster, for the Configure step's cap.
  const { data: clusterView } = useQuery({
    queryKey: ["cluster-view", clusterId],
    queryFn: ({ signal }) => client.withSignal(signal).Cluster.view(),
    staleTime: 30_000,
  });
  const caps = nodeCaps(clusterView?.nodes ?? []);
  const stepCheck = validateStep(currentKey, state, caps);
  const finalCheck = steps
    .filter((k) => k !== "review")
    .every((k) => validateStep(k, state, caps).ok)
    ? ({ ok: true } as const)
    : ({ ok: false } as const);

  return (
    // Fixed inset-0 backdrop over the surrounding app chrome (design W8idqY:
    // 960×760 centered card at 12px radius over a #000000B3 backdrop). The
    // cap is viewport-relative rather than a flat 760px: step content height
    // varies per step (design QQtUD's Step 4/Network frame is the showcase,
    // design f1Vga shows the broader modal layout). So a fixed 760px clips
    // the taller steps' scrollable body instead of just capping the dialog.
    <div className="fixed inset-0 flex items-center justify-center overflow-auto bg-black/70">
      <div role="dialog" aria-modal="true" className="w-[960px] max-h-[90vh] overflow-hidden rounded-[12px] border border-border bg-card shadow-2xl flex flex-col">
        <div className="flex shrink-0 items-start justify-between border-b border-border px-7 py-5">
          <div>
            <div className="text-lg font-semibold">New game server</div>
            <div className="pt-0.5 text-xs text-muted">
              Step {stepIndex + 1} of {steps.length} · {STEP_TITLES[currentKey]}
            </div>
          </div>
          <Button
            isIconOnly
            variant="ghost"
            isDisabled={create.isPending} onPress={closeWizard}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="border-b border-border px-6 py-3">
          <Select aria-label="Location" value={JSON.stringify([placement.cluster, placement.namespace])} isDisabled={create.isPending || choices.length < 2} onChange={(value) => onPlacementChange(String(value))}>
            <Label>Location</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover><ListBox>{choices.map((p) => <ListBoxItem key={JSON.stringify([p.cluster, p.namespace])} id={JSON.stringify([p.cluster, p.namespace])}>{p.cluster} / {p.namespace}</ListBoxItem>)}</ListBox></Select.Popover>
          </Select>
          <p className="mt-1 text-xs text-muted">Changing location starts a fresh draft. The chosen location handles all creation steps.</p>
          {partial && <p role="status" className="text-xs text-warning">Some locations are unavailable. Available locations are shown.</p>}
        </div>
        <StepBar steps={steps} stepIndex={stepIndex} />

        <div className="grid flex-1 min-h-0 overflow-auto gap-6 px-6 py-6 md:grid-cols-[1fr_260px]">
          <fieldset disabled={create.isPending} className="min-w-0">
            {currentKey === "template" && <PickTemplate templates={placement.templates} state={state} setState={setState} gameCodes={gameCodes} byName={byName} />}
            {currentKey === "version" && <PickVersion state={state} setState={setState} />}
            {currentKey === "configure" && <Configure caps={caps} nodeNames={(clusterView?.nodes ?? []).map((node) => node.name)} state={state} setState={setState} />}
            {currentKey === "network" && <Network state={state} setState={setState} />}
            {currentKey === "review" && (
              <Review
                location={`${placement.cluster} / ${placement.namespace}`}
                state={state}
                onEdit={(key) => {
                  const idx = steps.indexOf(key);
                  if (idx >= 0) setStepIndex(idx);
                }}
              />
            )}
          </fieldset>
          <Preview state={state} gameCodes={gameCodes} byName={byName} />
        </div>

        {create.isError && (
          <ErrorAlert {...errorMessage(create.error, state.name)} />
        )}

        <div className="flex shrink-0 items-center justify-between border-t border-border px-7 py-4">
          <a href={DOCS_CREATE_SERVER_URL} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-muted hover:text-fg">
            <ExternalLink className="h-3 w-3" /> Docs: Creating game servers
          </a>
          <div className="flex items-center gap-3">
            {!stepCheck.ok && !isLast && (
              <span className="text-[11px] text-muted" data-testid="step-reason">
                {stepCheck.reason}
              </span>
            )}
            {stepIndex === 0 ? (
              <Button variant="ghost" onPress={closeWizard}>
                Cancel
              </Button>
            ) : (
              <Button
                variant="ghost"
                isDisabled={create.isPending} onPress={() => setStepIndex((i) => Math.max(0, i - 1))}
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
            )}
            {!isLast ? (
              <Button
                variant="primary"
                isDisabled={!stepCheck.ok}
                onPress={() => setStepIndex((i) => Math.min(steps.length - 1, i + 1))}
              >
                Continue to {STEP_TITLES[steps[stepIndex + 1]]} <ArrowRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                variant="primary"
                className="rounded-full"
                onPress={() => create.mutate()}
                isDisabled={create.isPending || !finalCheck.ok}
              >
                {create.isPending ? (
                  <>Creating… <Loader2 className="h-4 w-4 animate-spin" /></>
                ) : (
                  <>{state.mode === "group" ? "Create group" : "Create server"} <Check className="h-4 w-4" /></>
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ErrorAlert({ title, body }: { title: string; body: string }) {
  return (
    <Alert status="danger" className="mx-6 mb-4" data-testid="create-error">
      <Alert.Indicator>
        <AlertCircle className="h-5 w-5 shrink-0" />
      </Alert.Indicator>
      <Alert.Content>
        <div className="font-medium">{title}</div>
        <div className="pt-1 text-xs">{body}</div>
      </Alert.Content>
    </Alert>
  );
}

function StepBar({ steps, stepIndex }: { steps: StepKey[]; stepIndex: number }) {
  return (
    <ol className="flex items-center gap-2 border-b border-border px-6 py-3 text-xs">
      {steps.map((key, i) => {
        const active = i === stepIndex;
        const done = i < stepIndex;
        return (
          <li key={key} className="flex items-center gap-2">
            <span
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[10px]",
                active ? "border-primary bg-primary/15 text-primary"
                       : done
                       ? "border-success bg-success/15 text-success"
                       : "border-border text-muted",
              )}
            >{done ? <Check className="h-3 w-3" /> : i + 1}</span>
            <span className={cn(active ? "text-fg" : "text-muted")}>{STEP_TITLES[key]}</span>
            {i < steps.length - 1 && <span className="text-muted">·</span>}
          </li>
        );
      })}
    </ol>
  );
}

function PickTemplate({
  templates,
  state,
  setState,
  gameCodes,
  byName,
}: {
  state: WizardState;
  setState: (s: WizardState) => void;
  gameCodes: Map<string, string>;
  byName: Map<string, GameTemplate>;
  templates: GameTemplate[];
}) {
  const data = { items: templates };
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");

  const templateCategories = useMemo(
    () =>
      categoryFilters((data?.items ?? []).map((t) => resolveCategories(t.spec.categories, t.spec.game))),
    [data],
  );
  // The chips come from the data, so a selected category can disappear when the
  // template list changes. Fall back to "all" instead of showing an empty
  // picker with no chip highlighted.
  const activeCat = templateCategories.includes(cat) ? cat : "all";

  const needle = q.trim().toLowerCase();
  const filtered = (data?.items ?? []).filter((t) => {
    if (!matchesCategory(t.spec.categories, t.spec.game, activeCat)) return false;
    if (needle) {
      const hay = `${t.spec.displayName} ${t.spec.game} ${t.spec.description ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2">
        <Input
          placeholder="Search…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search templates"
        />
        <div className="flex flex-wrap gap-1 rounded-md border border-border bg-surface/40 p-1">
          {templateCategories.map((c: string) => (
            <Button
              key={c}
              size="sm"
              variant={activeCat === c ? "primary" : "ghost"}
              onPress={() => setCat(c)}
              aria-pressed={activeCat === c}
              // No radius class needed: globals.css's unlayered
              // `.button:not(.rounded-full) { border-radius: 6px }` already
              // pins every HeroUI Button — these category chips included —
              // to the design's 6px, and wins over any Tailwind utility
              // class added here anyway.
            >
              {c === "all" ? "All" : c}
            </Button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {filtered.map((t) => {
          const active = state.template?.metadata.name === t.metadata.name;
          return (
            <button
              key={t.metadata.name}
              onClick={() => setState({ ...state, template: t, config: {}, version: defaultVersionId(t) ?? "" })}
              className={cn(
                "rounded-lg border p-4 text-left transition-colors",
                active ? "border-primary bg-primary/5"
                       : "border-border hover:bg-surface/60",
              )}
            >
              <div className="flex items-center gap-3">
                <GameIcon
                  game={t.spec.game}
                  icon={byName.get(t.metadata.name)?.spec.icon}
                  code={gameCodes.get(t.metadata.name)}
                  size="md"
                />
                <div>
                  <div className="text-sm font-medium">{t.spec.displayName}</div>
                  <div className="text-[11px] text-muted">v{t.spec.version}</div>
                </div>
              </div>
              <p className="pt-2 text-xs text-muted line-clamp-2">
                {t.spec.description ?? "No description."}
              </p>
            </button>
          );
        })}
      </div>
      {filtered.length === 0 && (
        <p className="text-sm text-muted">No templates match your search.</p>
      )}
    </div>
  );
}

function PickVersion({ state, setState }: { state: WizardState; setState: (s: WizardState) => void }) {
  const versions = state.template?.spec.versions ?? [];
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">Choose a version</div>
      <p className="text-xs text-muted">
        Pick the version and loader for this server. Each loader keeps its own mods on a separate
        volume, so switching never clobbers another.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {versions.map((v) => {
          const active = state.version === v.id;
          return (
            <button
              key={v.id}
              onClick={() => setState({ ...state, version: v.id })}
              className={cn(
                "rounded-lg border p-4 text-left transition-colors",
                active ? "border-primary bg-primary/5"
                       : "border-border hover:bg-surface/60",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium">{v.displayName}</div>
                {v.default && (
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">
                    Default
                  </span>
                )}
              </div>
              {v.loader && <div className="pt-1 text-[11px] text-muted">Loader: {v.loader}</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Configure({ state, setState, caps, nodeNames }: { state: WizardState; setState: (s: WizardState) => void; caps: { maxCpu: number; maxMemGi: number }; nodeNames: string[] }) {
  const fields = state.template?.spec.configSchema ?? [];
  // Cap CPU/memory at the largest single node's capacity — the scheduler
  // can never place a pod that requests more than one node provides, so
  // let the user know the ceiling and clamp their input to it.
  const { maxCpu, maxMemGi } = caps;
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <span className="block text-xs text-muted">Deployment</span>
        <div className="inline-flex gap-1 rounded-md border border-border p-1" role="group" aria-label="Deployment">
          {(["single", "group"] as const).map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant={state.mode === mode ? "primary" : "ghost"}
              aria-pressed={state.mode === mode}
              onPress={() => {
                if (mode !== state.mode) setState({ ...state, mode, ephemeral: mode === "group" });
              }}
            >
              {mode === "single" ? "Single server" : "Server group"}
            </Button>
          ))}
        </div>
        <span className="block text-[11px] text-muted">
          {state.mode === "single"
            ? "One server with its own address."
            : `Identical replicas named ${state.name || "<name>"}-0, ${state.name || "<name>"}-1, … each with its own address.`}
        </span>
      </div>
      <div className="space-y-1.5">
        <label className="block text-xs text-muted">Server name</label>
        <Input
          value={state.name}
          onChange={(e) => setState({ ...state, name: e.target.value })}
          placeholder="mc-hardcore"
          required
        />
        <span className="text-[11px] text-muted">
          Used as pod name and subdomain. Lowercase, dash-separated.
        </span>
      </div>
      <div className="space-y-1.5">
        <label className="block text-xs text-muted">Description</label>
        <textarea
          className="min-h-[72px] w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-hidden"
          value={state.description}
          onChange={(e) => setState({ ...state, description: e.target.value })}
          placeholder="Hardcore survival realm with curated mods. Invite only."
        />
      </div>

      {state.mode === "group" && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="replicas" className="block text-xs text-muted">Replicas</label>
            <Input
              id="replicas"
              type="number"
              min={1}
              max={100}
              value={state.replicas}
              onChange={(event) => setState({ ...state, replicas: event.target.value })}
              className="w-32"
            />
          </div>
          <div className="space-y-1.5">
            <span className="block text-xs text-muted">Nodes</span>
            {nodeNames.length === 0 ? (
              <span className="block text-[11px] text-muted">Node list unavailable. The scheduler places the replicas.</span>
            ) : (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Nodes">
                {nodeNames.map((node) => (
                  <label key={node} className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={state.nodes.includes(node)}
                      onChange={(event) => setState({ ...state, nodes: event.target.checked ? [...state.nodes, node] : state.nodes.filter((selected) => selected !== node) })}
                    />
                    <span className="font-mono">{node}</span>
                  </label>
                ))}
              </div>
            )}
            <span className="block text-[11px] text-muted">Replicas run only on the selected nodes and spread across them. None selected: any node.</span>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor="image" className="block text-xs text-muted">Container image (optional)</label>
        <Input
          id="image"
          value={state.image}
          onChange={(event) => setState({ ...state, image: event.target.value })}
          placeholder="registry.example.com/lobby:1.0"
        />
        <span className="text-[11px] text-muted">Overrides the template image. Requires admin.</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="block text-xs text-muted">CPU</label>
          <ResourceInput
            kind="cpu"
            value={state.cpuLimit}
            onChange={(q) => setState({ ...state, cpuLimit: q })}
            max={maxCpu > 0 ? maxCpu : undefined}
          />
          {maxCpu > 0 && (
            <span className="text-[11px] text-muted">Max {maxCpu} (largest node)</span>
          )}
        </div>
        <div className="space-y-1.5">
          <label className="block text-xs text-muted">Memory</label>
          <ResourceInput
            kind="memory"
            value={state.memoryLimit}
            onChange={(q) => setState({ ...state, memoryLimit: q })}
            max={maxMemGi > 0 ? maxMemGi : undefined}
          />
          {maxMemGi > 0 && (
            <span className="text-[11px] text-muted">Max {maxMemGi} GiB (largest node)</span>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={state.ephemeral} onChange={(event) => setState({ ...state, ephemeral: event.target.checked })} />
          Ephemeral storage
        </label>
        <span className="block text-[11px] text-muted">
          {state.ephemeral ? "No volume: data is wiped on every restart. Backups are unavailable." : "Data is kept on a persistent volume."}
        </span>
      </div>

      {!state.ephemeral && (
        <div className="space-y-1.5">
          <label className="block text-xs text-muted">Persistent storage</label>
          <Input
            value={state.storageSize}
            onChange={(event) => setState({ ...state, storageSize: event.target.value })}
            placeholder="50Gi"
          />
          <span className="text-[11px] text-muted">Mounted at /data (RWO PVC).</span>
        </div>
      )}

      {state.mode === "single" && (
        <div className="space-y-1.5">
          <label className="block text-xs text-muted">Node placement</label>
          <div className="inline-flex gap-1 rounded-md border border-border p-1">
            {(["auto", "pin", "gpu"] as const).map((placement) => (
              <Button
                key={placement}
                size="sm"
                variant={state.nodePlacement === placement ? "primary" : "ghost"}
                onPress={() => setState({ ...state, nodePlacement: placement })}
              >
                {placement === "auto" ? "Auto (scheduler)" : placement === "pin" ? "Pin to node" : "GPU-enabled"}
              </Button>
            ))}
          </div>
          <div className="text-[11px] text-muted">
            {state.nodePlacement === "auto" && "Picks node with most free memory, tolerations or no taints."}
            {state.nodePlacement === "pin" && "Pins to a specific node (selectable after create)."}
            {state.nodePlacement === "gpu" && "Requires node with a GPU-capable device plugin."}
          </div>
        </div>
      )}

      {fields.length > 0 && (
        <div className="space-y-3 pt-3">
          <div className="text-xs uppercase tracking-wide text-muted">Template configuration</div>
          <ConfigFields
            schema={fields}
            values={state.config}
            onChange={(name, value) =>
              setState({ ...state, config: { ...state.config, [name]: value } })
            }
          />
        </div>
      )}
    </div>
  );
}

function Network({ state, setState }: { state: WizardState; setState: (s: WizardState) => void }) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="block text-xs text-muted">Expose</label>
        <div className="grid gap-2 sm:grid-cols-3">
          {(["ClusterIP", "NodePort", "LoadBalancer"] as const).map((e) => (
            <button
              key={e}
              onClick={() => setState({ ...state, expose: e })}
              className={cn(
                "rounded-md border p-3 text-left text-sm",
                state.expose === e
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-surface/60",
              )}
            >
              <div className="font-medium">{e}</div>
              <div className="pt-0.5 text-[11px] text-muted">
                {e === "ClusterIP" && "Internal to cluster only."}
                {e === "NodePort" && "Reach via any node's IP."}
                {e === "LoadBalancer" && "Provisions an external LB."}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5 border-t border-border pt-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={state.tunnelEnabled}
            onChange={(e) => setState({ ...state, tunnelEnabled: e.target.checked })}
            className="h-4 w-4 rounded border border-border bg-surface accent-primary"
          />
          <span className="text-xs font-medium">Enable tunnel</span>
        </label>
        {state.tunnelEnabled && (
          <div className="rounded-md border border-border bg-surface/40 p-3 space-y-3">
            <div>
              <label className="block text-xs mb-2">Tunnel provider</label>
              <div className="grid gap-2 sm:grid-cols-3">
                {(["frp", "tailscale", "playit"] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setState({ ...state, tunnelProvider: p })}
                    className={cn(
                      "rounded-md border p-2 text-left text-xs",
                      state.tunnelProvider === p
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-surface/60",
                    )}
                  >
                    <div className="font-medium">{p === "tailscale" ? "Tailscale" : p === "playit" ? "playit.gg" : "frp"}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">Credentials *</label>
                <Input
                  type="password"
                  value={state.tunnelCredentialsValue}
                  onChange={(e) => setState({ ...state, tunnelCredentialsValue: e.target.value })}
                  placeholder={
                    state.tunnelProvider === "frp"
                      ? "frp token"
                      : state.tunnelProvider === "tailscale"
                        ? "Tailscale auth key"
                        : "playit secret key"
                  }
                  data-testid="tunnel-credentials-input"
                />
                <span className="text-[11px] text-muted">
                  {state.tunnelProvider === "frp"
                    ? "Your frp authentication token"
                    : state.tunnelProvider === "tailscale"
                      ? "Tailscale OAuth token (usually ts_<id>=<secret>)"
                      : "Your playit.gg secret key"}
                </span>
              </div>

              <div className="border-t border-border/50 pt-3 space-y-1.5">
                <label className="block text-xs">Or use existing Secret (GitOps)</label>
                <Input
                  value={state.tunnelCredentialsSecretName}
                  onChange={(e) => setState({ ...state, tunnelCredentialsSecretName: e.target.value })}
                  placeholder="my-tunnel-secret"
                  data-testid="tunnel-existing-secret"
                />
                <span className="text-[11px] text-muted">
                  Name of a pre-existing Kubernetes Secret. Leave empty to create a new one from the credentials above.
                </span>
              </div>
            </div>

            {state.tunnelProvider === "frp" && (
              <div className="space-y-3 pt-2 border-t border-border/50">
                <div className="space-y-1.5">
                  <label className="block text-xs">Server address *</label>
                  <Input
                    value={state.frpServerAddr}
                    onChange={(e) => setState({ ...state, frpServerAddr: e.target.value })}
                    placeholder="relay.example.com"
                    data-testid="frp-server-addr"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs">Server port</label>
                  <Input
                    type="number"
                    min="1"
                    max="65535"
                    value={state.frpServerPort}
                    onChange={(e) => {
                      const val = e.target.value;
                      setState({ ...state, frpServerPort: val === "" ? "" : val });
                    }}
                    placeholder="7000"
                    data-testid="frp-server-port"
                  />
                  <span className="text-[11px] text-muted">
                    Default 7000. Must be between 1 and 65535.
                  </span>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs">Port mappings *</label>
                  <TunnelPortMappingsEditor
                    values={state.frpRemotePortMappings}
                    onChange={(v) => setState({ ...state, frpRemotePortMappings: v })}
                  />
                  <span className="text-[11px] text-muted">
                    Map at least one port name to a remote port (1–65535).
                  </span>
                </div>
              </div>
            )}

            {state.tunnelProvider === "tailscale" && (
              <div className="space-y-3 pt-2 border-t border-border/50">
                <p className="text-[11px] text-warning bg-warning/10 rounded px-2 py-1.5">
                  Tailscale access is tailnet-private only and not reachable from the internet.
                </p>
                <div className="space-y-1.5">
                  <label className="block text-xs">Hostname (optional)</label>
                  <Input
                    value={state.tailscaleHostname}
                    onChange={(e) => setState({ ...state, tailscaleHostname: e.target.value })}
                    placeholder="my-server"
                    data-testid="tailscale-hostname"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs">Tags (optional)</label>
                  <Input
                    value={state.tailscaleTags}
                    onChange={(e) => setState({ ...state, tailscaleTags: e.target.value })}
                    placeholder="tag:game,tag:public"
                    data-testid="tailscale-tags"
                  />
                  <span className="text-[11px] text-muted">
                    Comma or space separated.
                  </span>
                </div>
              </div>
            )}

            {state.tunnelProvider === "playit" && (
              <div className="space-y-3 pt-2 border-t border-border/50">
                <div className="space-y-1.5">
                  <label className="block text-xs">Tunnel name (optional)</label>
                  <Input
                    value={state.playitTunnelName}
                    onChange={(e) => setState({ ...state, playitTunnelName: e.target.value })}
                    placeholder="my-game-server"
                    data-testid="playit-tunnel-name"
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <label className="block text-xs text-muted">Hostname (optional)</label>
        <Input
          value={state.hostname}
          onChange={(e) => setState({ ...state, hostname: e.target.value })}
          placeholder="mc.example.dev"
        />
      </div>
      {/* A div, not a label: the editor holds several inputs and buttons, and
          a label wrapping multiple interactive elements mis-associates them. */}
      <div className="space-y-1.5">
        <label className="block text-xs text-muted">Port overrides (optional)</label>
        <PortOverridesEditor
          values={state.portOverrides}
          onChange={(v) => setState({ ...state, portOverrides: v })}
        />
        <span className="block text-[11px] text-muted">
          Pin a NodePort or override the Service port for a named template port.
        </span>
      </div>
      {state.expose === "LoadBalancer" && (
        <div className="space-y-1.5">
          <label className="block text-xs text-muted">IP allow-list (CIDRs, optional)</label>
          <textarea
            className="block w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm"
            rows={3}
            value={state.sourceRanges}
            onChange={(e) => setState({ ...state, sourceRanges: e.target.value })}
            placeholder={"203.0.113.0/24\n10.0.0.0/8"}
            aria-label="IP allow-list"
          />
          <span className="text-[11px] text-muted">
            One CIDR per line. Restricts which clients reach the LoadBalancer; empty allows all.
          </span>
        </div>
      )}

      <div className="space-y-1.5 border-t border-border pt-4">
        <label className="block text-xs text-muted">Load balancer address (optional)</label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="block text-xs font-medium">Address pool</label>
            <Input
              value={state.addressPool}
              onChange={(e) => setState({ ...state, addressPool: e.target.value })}
              placeholder="pool-us-west"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs font-medium">Requested address</label>
            <Input
              value={state.requestedAddress}
              onChange={(e) => setState({ ...state, requestedAddress: e.target.value })}
              placeholder="203.0.113.50"
            />
          </div>
        </div>
        <span className="text-[11px] text-muted">
          Name of a load-balancer address pool configured by your cluster admin, plus an optional specific address to request. Applies only when Expose is set to LoadBalancer — ignored otherwise.
        </span>

        {(state.addressPool.trim() || state.requestedAddress.trim()) && state.expose !== "LoadBalancer" && (
          <div className="flex items-start gap-4 rounded-lg border border-warning-soft-foreground bg-warning-soft px-5 py-4">
            <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-warning-soft-foreground" />
            <div className="flex-1">
              <div className="mb-0.5 font-medium text-warning-soft-foreground">Address preference ignored</div>
              <div className="text-sm text-warning-soft-foreground">
                Expose is set to {state.expose}. Address pool and requested address only take effect when Expose (above) is set to LoadBalancer.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TunnelPortMappingsEditor({
  values,
  onChange,
}: {
  values: Array<{ name: string; remotePort: number }>;
  onChange: (v: Array<{ name: string; remotePort: number }>) => void;
}) {
  return (
    <div className="space-y-2">
      {values.map((item, i) => (
        <div key={i} className="flex gap-2 items-end">
          <div className="flex-1 space-y-1">
            <label className="text-[11px] text-muted">Port name</label>
            <Input
              value={item.name}
              onChange={(e) => {
                const newValues = [...values];
                newValues[i] = { ...item, name: e.target.value };
                onChange(newValues);
              }}
              placeholder="game-port"
              data-testid={`tunnel-port-name-${i}`}
            />
          </div>
          <div className="flex-1 space-y-1">
            <label className="text-[11px] text-muted">Remote port</label>
            <Input
              type="number"
              min="1"
              max="65535"
              value={item.remotePort}
              onChange={(e) => {
                const newValues = [...values];
                const parsed = parseInt(e.target.value, 10);
                newValues[i] = { ...item, remotePort: isNaN(parsed) ? 0 : parsed };
                onChange(newValues);
              }}
              placeholder="25565"
              data-testid={`tunnel-port-number-${i}`}
            />
          </div>
          <Button
            size="sm"
            variant="danger"
            isIconOnly
            onPress={() => onChange(values.filter((_, idx) => idx !== i))}
            aria-label="Delete"
            data-testid={`tunnel-port-delete-${i}`}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="primary"
        onPress={() => onChange([...values, { name: "", remotePort: 0 }])}
        data-testid="tunnel-port-add"
      >
        Add port mapping
      </Button>
    </div>
  );
}

function Review({ state, onEdit, location }: { state: WizardState; onEdit: (key: StepKey) => void; location: string }) {
  const hasVersions = (state.template?.spec.versions?.length ?? 0) > 0;
  const sections = [
    {
      key: "template",
      title: "Template",
      rows: [["Template", state.template?.spec.displayName ?? "—"]] as Array<[string, string]>,
    },
    ...(hasVersions
      ? [{ key: "version", title: "Version", rows: [["Version", state.version || "—"]] as Array<[string, string]> }]
      : []),
    {
      key: "configure",
      title: "Configuration",
      rows: [
        ["Name", state.name || "—"],
        ["Location", location],
        ["CPU", state.cpuLimit],
        ["Memory", state.memoryLimit],
        ["Deployment", state.mode === "group" ? `Group of ${state.replicas}` : "Single server"],
        ...(state.mode === "group" ? [["Nodes", state.nodes.length ? state.nodes.join(", ") : "Any"] as [string, string]] : []),
        ["Image", state.image.trim() || "Template default"],
        ["Storage", state.ephemeral ? "Ephemeral" : state.storageSize],
        ...(state.mode === "single" ? [["Placement", state.nodePlacement] as [string, string]] : []),
      ] as Array<[string, string]>,
    },
    {
      key: "network",
      title: "Network",
      rows: [
        ["Expose", state.expose],
        ["Hostname", state.hostname || "—"],
        ...(state.tunnelEnabled
          ? [
              ["Tunnel provider", state.tunnelProvider === "tailscale" ? "Tailscale" : state.tunnelProvider === "playit" ? "playit.gg" : "frp"] as [string, string],
              ["Tunnel credentials", state.tunnelCredentialsValue.trim() ? "✓ Configured" : state.tunnelCredentialsSecretName ? `Secret: ${state.tunnelCredentialsSecretName}` : "—"] as [string, string],
              ...(state.tunnelProvider === "frp"
                ? [
                    ["frp server", state.frpServerAddr || "—"] as [string, string],
                    ...(nonEmptyTunnelPortMappings(state.frpRemotePortMappings).length > 0
                      ? [[
                          "frp port mappings",
                          nonEmptyTunnelPortMappings(state.frpRemotePortMappings)
                            .map((m) => `${m.name}→${m.remotePort}`)
                            .join(", "),
                        ] as [string, string]]
                      : []),
                  ]
                : []),
              ...(state.tunnelProvider === "tailscale"
                ? [
                    ...(state.tailscaleHostname ? [["Tailscale hostname", state.tailscaleHostname] as [string, string]] : []),
                    ...(state.tailscaleTags ? [["Tailscale tags", state.tailscaleTags] as [string, string]] : []),
                  ]
                : []),
              ...(state.tunnelProvider === "playit"
                ? [
                    ...(state.playitTunnelName ? [["playit tunnel name", state.playitTunnelName] as [string, string]] : []),
                  ]
                : []),
            ]
          : []),
        ...(nonEmptyPortOverrides(state.portOverrides).length > 0
          ? [[
              "Port overrides",
              nonEmptyPortOverrides(state.portOverrides)
                .map((p) => p.name)
                .join(", "),
            ] as [string, string]]
          : []),
        ...(state.expose === "LoadBalancer"
          ? [["IP allow-list", parseSourceRanges(state.sourceRanges).join(", ") || "all"] as [string, string]]
          : []),
      ] as Array<[string, string]>,
    },
  ] as Array<{ key: StepKey; title: string; rows: Array<[string, string]> }>;
  return (
    <div className="space-y-4 text-sm">
      {sections.map((sec) => (
        <div key={sec.key}>
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs uppercase tracking-wide text-muted">{sec.title}</span>
            <Button
              variant="ghost"
              size="sm"
              onPress={() => onEdit(sec.key)}
            >
              Edit
            </Button>
          </div>
          {sec.rows.map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-border py-1.5">
              <span className="text-muted">{k}</span>
              <span className="font-mono">{v}</span>
            </div>
          ))}
        </div>
      ))}
      {Object.keys(state.config).length > 0 && (
        <div className="pt-1">
          <div className="pb-1 text-xs uppercase text-muted">Template config</div>
          <pre className="max-h-64 overflow-auto rounded bg-surface p-3 font-mono text-xs scrollbar-thin">
            {JSON.stringify(maskPasswordConfig(state.template?.spec.configSchema ?? [], state.config), null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function Preview({
  state,
  gameCodes,
  byName,
}: {
  state: WizardState;
  gameCodes: Map<string, string>;
  byName: Map<string, GameTemplate>;
}) {
  const name = state.template?.spec.displayName ?? "Pick a template";
  const isGroup = state.mode === "group";
  const yaml = state.template
    ? `apiVersion: gameplane.local/v1alpha1
kind: ${isGroup ? "GameServerSet" : "GameServer"}
metadata:
  name: ${state.name || "server-name"}
spec:
${isGroup ? `  replicas: ${state.replicas}\n` : ""}  templateRef:
    name: ${state.template.metadata.name}
${state.version ? `  version: ${state.version}\n` : ""}  resources:
    cpu: ${state.cpuLimit}
    memory: ${state.memoryLimit}
    storage: ${state.ephemeral ? "ephemeral" : state.storageSize}
`
    : "# Pick a template to preview the YAML.";
  return (
    <aside className="min-w-0 rounded-lg border border-border bg-surface/40 flex flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 min-w-0">
        <GameIcon
          game={state.template?.spec.game}
          icon={state.template ? byName.get(state.template.metadata.name)?.spec.icon : undefined}
          code={state.template ? gameCodes.get(state.template.metadata.name) : undefined}
          size="sm"
        />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="truncate text-[10px] text-muted">
            Template: {state.template?.metadata.name ?? "—"}
          </div>
        </div>
      </div>
      {/* whitespace-pre-wrap + break-words: wrap long lines (e.g. a long
          server/template name) instead of growing a horizontal scrollbar —
          the pane must fit its column at any width. overflow-auto is still
          needed for vertical scroll past max-h-72. */}
      <pre className="min-w-0 max-h-72 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11px] leading-relaxed text-fg scrollbar-thin">
{yaml}
      </pre>
      <div className="min-w-0 border-t border-border px-4 py-3 text-[11px] text-muted">
        <span className="font-medium text-fg">Memory tip.</span>
        {" "}Factor in mod/plugin overhead; Minecraft Vanilla uses ~1.5 GB at 4 players.
      </div>
    </aside>
  );
}
