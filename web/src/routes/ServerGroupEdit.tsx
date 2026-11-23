import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Loader2 } from "lucide-react";
import { Button, Card, Input, Label, ListBox, ListBoxItem, Select } from "@heroui/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingCard } from "@/components/ui/LoadingCard";
import { ErrorCard } from "@/components/ui/ErrorCard";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { RequestLimitCard, resourcesValid } from "@/components/ui/RequestLimitCard";
import { ConfigFields } from "@/components/server/ConfigFields";
import { createResourceClient, type ResourceClient } from "@/lib/endpoints";
import { DEFAULT_NAMESPACE } from "@/lib/cluster";
import { targetLabel } from "@/lib/fleet";
import { validateConfig } from "@/lib/validation";
import { useOptionalIntl } from "@/lib/i18n/format";
import { moduleIds, useModuleText } from "@/lib/i18n/moduleText";
import { ANY_NODE, nodeCaps, pinReplica, replicaOrdinals, replicaPlacement } from "@/routes/CreateServer";
import type { GameServerSet, GameTemplate, ResourceRequirements } from "@/types";

const DESCRIPTION_ANNOTATION = "gameplane.local/description";
const DEFAULT_VERSION = "__default__";

interface Draft {
  description: string;
  replicas: string;
  nodes: string[];
  pins: string[];
  minReadySeconds: string;
  version: string;
  image: string;
  resources: ResourceRequirements;
  config: Record<string, string>;
}

function draftFrom(set: GameServerSet): Draft {
  const pins: string[] = [];
  for (const { ordinal, node } of set.spec.placement ?? []) pins[ordinal] = node;
  return {
    description: set.metadata.annotations?.[DESCRIPTION_ANNOTATION] ?? "",
    replicas: String(set.spec.replicas),
    nodes: set.spec.nodes ?? [],
    pins,
    minReadySeconds: set.spec.minReadySeconds ? String(set.spec.minReadySeconds) : "",
    version: set.spec.template.version ?? "",
    image: set.spec.template.image ?? "",
    resources: set.spec.template.resources ?? {},
    config: set.spec.template.config ?? {},
  };
}

function applyDraft(set: GameServerSet, draft: Draft): GameServerSet {
  const ephemeral = !!set.spec.template.storage?.ephemeral;
  const statefulSet = set.spec.mode === "StatefulSet";
  const placement = replicaPlacement({ pins: draft.pins, replicas: draft.replicas, ephemeral });
  const annotations = { ...set.metadata.annotations };
  if (draft.description.trim()) annotations[DESCRIPTION_ANNOTATION] = draft.description.trim();
  else delete annotations[DESCRIPTION_ANNOTATION];
  return {
    ...set,
    metadata: { ...set.metadata, annotations },
    spec: {
      ...set.spec,
      replicas: Number(draft.replicas),
      nodes: ephemeral ? (draft.nodes.length ? draft.nodes : undefined) : set.spec.nodes,
      placement: statefulSet && placement.length ? placement : undefined,
      minReadySeconds: statefulSet && draft.minReadySeconds ? Number(draft.minReadySeconds) : undefined,
      template: {
        ...set.spec.template,
        version: draft.version || undefined,
        image: draft.image.trim() || undefined,
        resources: draft.resources,
        config: draft.config,
      },
    },
  };
}

export function ServerGroupEditPage() {
  const intl = useOptionalIntl();
  const { name } = useParams({ from: "/app-layout/servers/groups/$name" });
  const { cluster = "local", ns = DEFAULT_NAMESPACE } = useSearch({ from: "/app-layout/servers/groups/$name" });
  const client = useMemo(() => createResourceClient({ cluster, namespace: ns }), [cluster, ns]);
  const set = useQuery({ queryKey: ["serverset", cluster, ns, name], queryFn: () => client.ServerSets.get(name) });
  const templateName = set.data?.spec.template.templateRef.name;
  const template = useQuery({
    queryKey: ["template", cluster, templateName],
    queryFn: ({ signal }) => client.withSignal(signal).Templates.get(templateName ?? ""),
    enabled: !!templateName,
  });

  const back = (
    <Link to="/servers" search={cluster === "local" ? {} : { cluster }} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
      <ArrowLeft className="h-4 w-4" /> {intl.formatMessage({ id: "web.routes.server_group_edit.back_to_servers", defaultMessage: "Back to servers", description: "Server group edit: link that returns to the servers list; keep it short" })}
    </Link>
  );
  if (set.isPending || (templateName && template.isPending)) return <div className="space-y-6 p-6">{back}<LoadingCard /></div>;
  if (set.error || template.error || !set.data || !template.data) {
    return (
      <div className="space-y-6 p-6">
        {back}
        <ErrorCard
          title={intl.formatMessage({ id: "web.routes.server_group_edit.group_unavailable", defaultMessage: "Group unavailable", description: "Server group edit: title of the error card when the server group or its template cannot be loaded" })}
          message={intl.formatMessage({ id: "web.routes.server_group_edit.group_unavailable_message", defaultMessage: "The server group could not be loaded.", description: "Server group edit: message of the error card when the server group or its template cannot be loaded" })}
          onRetry={() => { void set.refetch(); void template.refetch(); }}
        />
      </div>
    );
  }
  return <GroupForm key={set.data.metadata.resourceVersion} set={set.data} template={template.data} client={client} cluster={cluster} namespace={ns} back={back} />;
}

function GroupForm({ set, template, client, cluster, namespace, back }: {
  set: GameServerSet; template: GameTemplate; client: ResourceClient; cluster: string; namespace: string; back: ReactNode;
}) {
  const intl = useOptionalIntl();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const text = useModuleText(template.metadata.name, cluster);
  const [draft, setDraft] = useState(() => draftFrom(set));
  const patch = (next: Partial<Draft>) => setDraft({ ...draft, ...next });
  const { data: clusterView } = useQuery({
    queryKey: ["cluster-view", cluster],
    queryFn: ({ signal }) => client.withSignal(signal).Cluster.view(),
    staleTime: 30_000,
  });
  const nodeNames = (clusterView?.nodes ?? []).map((node) => node.name);
  const { maxCpu, maxMemGi } = nodeCaps(clusterView?.nodes ?? []);
  const ephemeral = !!set.spec.template.storage?.ephemeral;
  const statefulSet = set.spec.mode === "StatefulSet";
  const fields = template.spec.configSchema ?? [];
  const versions = template.spec.versions ?? [];

  const save = useMutation({
    mutationFn: () => client.ServerSets.update(applyDraft(set, draft)),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["fleet"] });
      await navigate({ to: "/servers", search: cluster === "local" ? {} : { cluster } });
    },
  });

  const replicas = Number(draft.replicas);
  const minReady = Number(draft.minReadySeconds || "0");
  const configErrors = validateConfig(fields, draft.config, intl);
  let invalid: string | undefined;
  if (!Number.isInteger(replicas) || replicas < 0 || replicas > 100)
    invalid = intl.formatMessage({ id: "web.routes.server_group_edit.validation_replicas_range", defaultMessage: "Replicas must be a whole number from 0 to 100", description: "Server group edit: validation message when the replica count is not a whole number from 0 to 100" });
  else if (!Number.isInteger(minReady) || minReady < 0 || minReady > 3600)
    invalid = intl.formatMessage({ id: "web.routes.server_group_edit.validation_min_ready_range", defaultMessage: "Minimum ready time must be a whole number from 0 to 3600", description: "Server group edit: validation message when the minimum ready seconds is not a whole number from 0 to 3600" });
  else if (!resourcesValid(draft.resources))
    invalid = intl.formatMessage({ id: "web.routes.server_group_edit.validation_limit_below_request", defaultMessage: "A limit can't be lower than its request", description: "Server group edit: validation message when a CPU or memory limit is lower than its request" });
  else if (configErrors.length > 0)
    invalid = configErrors[0].message;

  const anyNode = intl.formatMessage({ id: "web.routes.server_group_edit.any_node", defaultMessage: "Any node", description: "Server group edit: replica node choice that lets the scheduler pick the node" });
  const nodesUnavailable = intl.formatMessage({ id: "web.routes.server_group_edit.node_list_unavailable", defaultMessage: "Node list unavailable. The scheduler places the replicas.", description: "Server group edit: hint shown instead of the node list when the nodes cannot be listed" });
  const nodesLabel = intl.formatMessage({ id: "web.routes.server_group_edit.nodes", defaultMessage: "Nodes", description: "Server group edit: label of the list of nodes the group's replicas may run on" });

  return (
    <div className="space-y-6 p-6 pb-24">
      {back}
      <PageHeader
        title={intl.formatMessage({ id: "web.routes.server_group_edit.title", defaultMessage: "Edit group {name}", description: "Server group edit: page title; {name} is the server group name" }, { name: set.metadata.name })}
        description={intl.formatMessage({ id: "web.routes.server_group_edit.subtitle", defaultMessage: "{location} · {game} · {mode}", description: "Server group edit: line under the title; {location} is cluster / namespace, {game} the game template, {mode} the deployment mode" }, { location: targetLabel({ cluster, namespace }), game: template.metadata.name, mode: set.spec.mode ?? "Independent" })}
      />

      <Card className="space-y-4 border border-border p-6">
        <SectionTitle>{intl.formatMessage({ id: "web.routes.server_group_edit.general", defaultMessage: "General", description: "Server group edit: heading of the card with the group description" })}</SectionTitle>
        <div className="space-y-1.5">
          <label htmlFor="description" className="block text-xs text-muted">{intl.formatMessage({ id: "web.routes.server_group_edit.description", defaultMessage: "Description", description: "Server group edit: field label for the optional free-text description of the group" })}</label>
          <textarea
            id="description"
            className="min-h-[72px] w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-primary focus:outline-hidden"
            value={draft.description}
            onChange={(event) => patch({ description: event.target.value })}
          />
        </div>
      </Card>

      <Card className="space-y-4 border border-border p-6">
        <SectionTitle>{intl.formatMessage({ id: "web.routes.server_group_edit.replicas_and_placement", defaultMessage: "Replicas and placement", description: "Server group edit: heading of the card with the replica count and node choices" })}</SectionTitle>
        <div className="flex flex-wrap gap-4">
          <div className="space-y-1.5">
            <label htmlFor="replicas" className="block text-xs text-muted">{intl.formatMessage({ id: "web.routes.server_group_edit.replicas", defaultMessage: "Replicas", description: "Server group edit: field label for how many replicas the group runs" })}</label>
            <Input id="replicas" type="number" min={0} max={100} value={draft.replicas} onChange={(event) => patch({ replicas: event.target.value })} className="w-32" />
          </div>
          {statefulSet && (
            <div className="space-y-1.5">
              <label htmlFor="min-ready" className="block text-xs text-muted">{intl.formatMessage({ id: "web.routes.server_group_edit.min_ready_seconds", defaultMessage: "Minimum ready seconds", description: "Server group edit: field label for how many seconds a replica must stay ready before the rollout moves on" })}</label>
              <Input id="min-ready" type="number" min={0} max={3600} value={draft.minReadySeconds} onChange={(event) => patch({ minReadySeconds: event.target.value })} className="w-32" />
            </div>
          )}
        </div>
        {ephemeral ? (
          <div className="space-y-1.5">
            <span className="block text-xs text-muted">{nodesLabel}</span>
            {nodeNames.length === 0 ? <span className="block text-[11px] text-muted">{nodesUnavailable}</span> : (
              <div className="flex flex-wrap gap-2" role="group" aria-label={nodesLabel}>
                {nodeNames.map((node) => (
                  <label key={node} className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.nodes.includes(node)}
                      onChange={(event) => patch({ nodes: event.target.checked ? [...draft.nodes, node] : draft.nodes.filter((selected) => selected !== node) })}
                    />
                    <span className="font-mono">{node}</span>
                  </label>
                ))}
              </div>
            )}
            <span className="block text-[11px] text-muted">{intl.formatMessage({ id: "web.routes.server_group_edit.nodes_hint", defaultMessage: "Replicas run only on the selected nodes and spread across them. None selected: any node.", description: "Server group edit: hint under the node list explaining replicas run only on the selected nodes, or on any node when none is selected" })}</span>
          </div>
        ) : statefulSet && (
          <div className="space-y-1.5">
            <span className="block text-xs text-muted">{intl.formatMessage({ id: "web.routes.server_group_edit.replica_nodes", defaultMessage: "Replica nodes", description: "Server group edit: label of the per-replica node choices of a group with persistent storage" })}</span>
            {nodeNames.length === 0 ? <span className="block text-[11px] text-muted">{nodesUnavailable}</span> : (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {replicaOrdinals(draft.replicas).map((ordinal) => (
                  <Select key={ordinal} value={draft.pins[ordinal] || ANY_NODE} onChange={(value) => patch({ pins: pinReplica(draft.pins, ordinal, String(value)) })}>
                    <Label>{intl.formatMessage({ id: "web.routes.server_group_edit.replica_name", defaultMessage: "{name}-{ordinal}", description: "Server group edit: label of one replica's node choice; {name} is the group name and {ordinal} the replica number" }, { name: set.metadata.name, ordinal })}</Label>
                    <Select.Trigger aria-label={intl.formatMessage({ id: "web.routes.server_group_edit.node_for_replica", defaultMessage: "Node for {name}-{ordinal}", description: "Server group edit: screen-reader label of one replica's node dropdown; {name} is the group name and {ordinal} the replica number" }, { name: set.metadata.name, ordinal })}><Select.Value /><Select.Indicator /></Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        <ListBoxItem key={ANY_NODE} id={ANY_NODE}>{anyNode}</ListBoxItem>
                        {nodeNames.map((node) => <ListBoxItem key={node} id={node}>{node}</ListBoxItem>)}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                ))}
              </div>
            )}
            <span className="block text-[11px] text-muted">{intl.formatMessage({ id: "web.routes.server_group_edit.replica_nodes_hint", defaultMessage: "A pin applies when the replica's volume is first created. Replicas that already have a volume stay on their node.", description: "Server group edit: hint under the per-replica node choices explaining a pin only affects replicas whose volume does not exist yet" })}</span>
          </div>
        )}
      </Card>

      <Card className="space-y-4 border border-border p-6">
        <SectionTitle>{intl.formatMessage({ id: "web.routes.server_group_edit.runtime", defaultMessage: "Runtime", description: "Server group edit: heading of the card with version, image and CPU/memory settings" })}</SectionTitle>
        {versions.length > 0 && (
          <Select value={draft.version || DEFAULT_VERSION} onChange={(value) => patch({ version: value === DEFAULT_VERSION ? "" : String(value) })} className="max-w-sm">
            <Label>{intl.formatMessage({ id: "web.routes.server_group_edit.version", defaultMessage: "Version", description: "Server group edit: label of the game version dropdown" })}</Label>
            <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBoxItem key={DEFAULT_VERSION} id={DEFAULT_VERSION}>{intl.formatMessage({ id: "web.routes.server_group_edit.template_default_version", defaultMessage: "Template default", description: "Server group edit: version choice that uses the template's default version" })}</ListBoxItem>
                {versions.map((version) => <ListBoxItem key={version.id} id={version.id}>{text(moduleIds.versionDisplayName(version.id), version.displayName)}</ListBoxItem>)}
              </ListBox>
            </Select.Popover>
          </Select>
        )}
        <div className="space-y-1.5">
          <label htmlFor="image" className="block text-xs text-muted">{intl.formatMessage({ id: "web.routes.server_group_edit.container_image", defaultMessage: "Container image (optional)", description: "Server group edit: field label for an optional container image that overrides the template image" })}</label>
          <Input id="image" value={draft.image} onChange={(event) => patch({ image: event.target.value })} placeholder={template.spec.image} />
          <span className="text-[11px] text-muted">{intl.formatMessage({ id: "web.routes.server_group_edit.image_hint", defaultMessage: "Overrides the template image. Requires admin.", description: "Server group edit: hint under the image field explaining it overrides the template image and needs the admin role" })}</span>
        </div>
        <RequestLimitCard kind="cpu" resources={draft.resources} onChange={(resources) => patch({ resources })} max={maxCpu > 0 ? maxCpu : undefined} />
        <RequestLimitCard kind="memory" resources={draft.resources} onChange={(resources) => patch({ resources })} max={maxMemGi > 0 ? maxMemGi : undefined} />
        <span className="block text-[11px] text-muted">
          {ephemeral
            ? intl.formatMessage({ id: "web.routes.server_group_edit.storage_ephemeral", defaultMessage: "Storage: ephemeral (fixed after creation)", description: "Server group edit: read-only note that the group uses ephemeral storage, which cannot change after creation" })
            : intl.formatMessage({ id: "web.routes.server_group_edit.storage_persistent", defaultMessage: "Storage: persistent volume {size} (fixed after creation)", description: "Server group edit: read-only note with the persistent volume size, which cannot change after creation; {size} is a quantity like 20Gi" }, { size: set.spec.template.storage?.size ?? intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" }) })}
        </span>
      </Card>

      {fields.length > 0 && (
        <Card className="space-y-4 border border-border p-6">
          <SectionTitle>{intl.formatMessage({ id: "web.routes.server_group_edit.template_configuration", defaultMessage: "Template configuration", description: "Server group edit: heading of the card with the template-specific settings" })}</SectionTitle>
          <ConfigFields
            schema={fields}
            values={draft.config}
            onChange={(field, value) => patch({ config: { ...draft.config, [field]: value } })}
            variant="settings"
            text={text}
            errors={Object.fromEntries(configErrors.map((error) => [error.name, error.message]))}
          />
        </Card>
      )}

      {save.error && <ErrorBanner err={save.error} onDismiss={() => save.reset()} />}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {invalid && <span className="text-xs text-danger">{invalid}</span>}
        <Button variant="ghost" isDisabled={save.isPending} onPress={() => void navigate({ to: "/servers", search: cluster === "local" ? {} : { cluster } })}>
          {intl.formatMessage({ id: "web.routes.server_group_edit.cancel", defaultMessage: "Cancel", description: "Server group edit: button that leaves the page without saving; keep it short" })}
        </Button>
        <Button variant="primary" isDisabled={!!invalid || save.isPending} onPress={() => save.mutate()}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {intl.formatMessage({ id: "web.routes.server_group_edit.save", defaultMessage: "Save changes", description: "Server group edit: button that saves the group changes; keep it short" })}
        </Button>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="text-xs uppercase tracking-wide text-muted">{children}</div>;
}
