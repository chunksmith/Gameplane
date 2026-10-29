import { Button } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { ResourceInput } from "@/components/ui/ResourceInput";
import { cn } from "@/lib/utils";
import { useOptionalIntl } from "@/lib/i18n/format";
import { cpuCores, memBytes, parseCpuQuantity, parseMemQuantity } from "@/lib/quantity";
import type { ResourceRequirements } from "@/types";

type ResourceKind = "cpu" | "memory";
type ResourceSide = "requests" | "limits";

const messages: Record<string, MessageDescriptor> = defineMessages({
  cpuTitle: { id: "web.components.ui.request_limit_card.cpu_title", defaultMessage: "CPU", description: "Resources card: title of the CPU request and limit card; technical term, usually left untranslated" },
  cpuDescription: { id: "web.components.ui.request_limit_card.cpu_description", defaultMessage: "The request is reserved on the node; the limit is the hard cap.", description: "Resources card: text under the CPU card title explaining request and limit" },
  memoryTitle: { id: "web.components.ui.request_limit_card.memory_title", defaultMessage: "Memory", description: "Resources card: title of the memory request and limit card" },
  memoryDescription: { id: "web.components.ui.request_limit_card.memory_description", defaultMessage: "Above the limit the server is OOM-killed; keep the Java heap below it.", description: "Resources card: text under the memory card title; OOM-killed means the process is stopped for using too much memory" },
  request: { id: "web.components.ui.request_limit_card.request", defaultMessage: "Request", description: "Resources card: label of the request field (amount reserved for the server on the node)" },
  limit: { id: "web.components.ui.request_limit_card.limit", defaultMessage: "Limit", description: "Resources card: label of the limit field (hard cap for the server)" },
  cpuRequestLabel: { id: "web.components.ui.request_limit_card.cpu_request_label", defaultMessage: "CPU request", description: "Resources card: accessible name of the CPU request slider and fields" },
  cpuLimitLabel: { id: "web.components.ui.request_limit_card.cpu_limit_label", defaultMessage: "CPU limit", description: "Resources card: accessible name of the CPU limit slider and fields" },
  memoryRequestLabel: { id: "web.components.ui.request_limit_card.memory_request_label", defaultMessage: "Memory request", description: "Resources card: accessible name of the memory request slider and fields" },
  memoryLimitLabel: { id: "web.components.ui.request_limit_card.memory_limit_label", defaultMessage: "Memory limit", description: "Resources card: accessible name of the memory limit slider and fields" },
  requestHint: { id: "web.components.ui.request_limit_card.request_hint", defaultMessage: "Reserved for the server. 0 = no request.", description: "Resources card: hint under the request field; 0 leaves the request unset" },
  cpuLimitHint: { id: "web.components.ui.request_limit_card.cpu_limit_hint", defaultMessage: "Throttled above this. 0 = no limit.", description: "Resources card: hint under the CPU limit field; 0 leaves the limit unset" },
  memoryLimitHint: { id: "web.components.ui.request_limit_card.memory_limit_hint", defaultMessage: "OOM-killed above this. 0 = no limit.", description: "Resources card: hint under the memory limit field; 0 leaves the limit unset" },
  cores: { id: "web.components.ui.request_limit_card.cores", defaultMessage: "{count, plural, one {# core} other {# cores}}", description: "Resources card: a CPU amount in cores used inside the summary line" },
  gib: { id: "web.components.ui.request_limit_card.gib", defaultMessage: "{count} GiB", description: "Resources card: a memory amount in GiB used inside the summary line" },
  bothSet: { id: "web.components.ui.request_limit_card.both_set", defaultMessage: "Request {request} of {limit} limit · {qos} QoS", description: "Resources card: summary under the bar when both are set; {request} and {limit} are amounts, {qos} is the Kubernetes QoS class name (Guaranteed, Burstable or BestEffort), keep it untranslated" },
  requestOnly: { id: "web.components.ui.request_limit_card.request_only", defaultMessage: "Request {request} · no limit · {qos} QoS", description: "Resources card: summary under the bar when only the request is set; {qos} is the Kubernetes QoS class name, keep it untranslated" },
  limitOnly: { id: "web.components.ui.request_limit_card.limit_only", defaultMessage: "No request, so Kubernetes uses the {limit} limit · {qos} QoS", description: "Resources card: summary under the bar when only the limit is set; Kubernetes then sets the request equal to the limit; {qos} is the Kubernetes QoS class name, keep it untranslated" },
  noneSet: { id: "web.components.ui.request_limit_card.none_set", defaultMessage: "No request or limit · {qos} QoS", description: "Resources card: summary under the bar when neither is set; {qos} is the Kubernetes QoS class name, keep it untranslated" },
  limitBelowRequest: { id: "web.components.ui.request_limit_card.limit_below_request", defaultMessage: "The limit can't be lower than the request.", description: "Resources card: error under the bar when the limit is below the request" },
  removeLimit: { id: "web.components.ui.request_limit_card.remove_limit", defaultMessage: "Remove limit", description: "Resources card: button under the limit field that clears the limit so the server has no hard cap" },
});

export function quantityAmount(kind: ResourceKind, quantity: string | undefined): number {
  if (!quantity) return 0;
  if (kind === "cpu") {
    const amount = parseCpuQuantity(quantity);
    return amount ? cpuCores(amount) : 0;
  }
  const amount = parseMemQuantity(quantity);
  return amount ? memBytes(amount) / 1024 ** 3 : 0;
}

export function setResource(resources: ResourceRequirements, kind: ResourceKind, side: ResourceSide, quantity: string): ResourceRequirements {
  const values = { ...resources[side], [kind]: quantityAmount(kind, quantity) > 0 ? quantity : undefined };
  const next: ResourceRequirements = { ...resources, [side]: values };
  const out: ResourceRequirements = {};
  for (const key of ["requests", "limits"] as const) {
    const kept = Object.fromEntries(Object.entries(next[key] ?? {}).filter(([, value]) => value));
    if (Object.keys(kept).length) out[key] = kept;
  }
  return out;
}

export function limitBelowRequest(resources: ResourceRequirements | undefined, kind: ResourceKind): boolean {
  const limit = quantityAmount(kind, resources?.limits?.[kind]);
  return limit > 0 && quantityAmount(kind, resources?.requests?.[kind]) > limit;
}

export function resourcesValid(resources: ResourceRequirements | undefined): boolean {
  return !limitBelowRequest(resources, "cpu") && !limitBelowRequest(resources, "memory");
}

export function qosClass(resources: ResourceRequirements | undefined): "Guaranteed" | "Burstable" | "BestEffort" {
  const kinds: ResourceKind[] = ["cpu", "memory"];
  const request = (kind: ResourceKind) => quantityAmount(kind, resources?.requests?.[kind]);
  const limit = (kind: ResourceKind) => quantityAmount(kind, resources?.limits?.[kind]);
  if (kinds.every((kind) => request(kind) === 0 && limit(kind) === 0)) return "BestEffort";
  const guaranteed = kinds.every((kind) => limit(kind) > 0 && (request(kind) === 0 || request(kind) === limit(kind)));
  return guaranteed ? "Guaranteed" : "Burstable";
}

export function RequestLimitCard({
  kind,
  resources,
  onChange,
  max,
}: {
  kind: ResourceKind;
  resources: ResourceRequirements | undefined;
  onChange: (next: ResourceRequirements) => void;
  max?: number;
}) {
  const intl = useOptionalIntl();
  const current = resources ?? {};
  const isCpu = kind === "cpu";
  const request = quantityAmount(kind, current.requests?.[kind]);
  const limit = quantityAmount(kind, current.limits?.[kind]);
  const invalid = limitBelowRequest(current, kind);
  const qos = qosClass(current);
  const amount = (count: number) => intl.formatMessage(isCpu ? messages.cores : messages.gib, { count });

  const fields = [
    { side: "requests" as const, title: messages.request, label: isCpu ? messages.cpuRequestLabel : messages.memoryRequestLabel, hint: messages.requestHint },
    { side: "limits" as const, title: messages.limit, label: isCpu ? messages.cpuLimitLabel : messages.memoryLimitLabel, hint: isCpu ? messages.cpuLimitHint : messages.memoryLimitHint },
  ];

  let summary: string;
  if (invalid) summary = intl.formatMessage(messages.limitBelowRequest);
  else if (request > 0 && limit > 0) summary = intl.formatMessage(messages.bothSet, { request: amount(request), limit: amount(limit), qos });
  else if (request > 0) summary = intl.formatMessage(messages.requestOnly, { request: amount(request), qos });
  else if (limit > 0) summary = intl.formatMessage(messages.limitOnly, { limit: amount(limit), qos });
  else summary = intl.formatMessage(messages.noneSet, { qos });

  const fill = invalid || (request > 0) !== (limit > 0) ? 100 : limit > 0 ? (request / limit) * 100 : 0;

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div>
        <h3 className="text-[15px] font-semibold text-fg">{intl.formatMessage(isCpu ? messages.cpuTitle : messages.memoryTitle)}</h3>
        <p className="pt-1 text-[13px] text-muted">{intl.formatMessage(isCpu ? messages.cpuDescription : messages.memoryDescription)}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fields.map((field) => (
          <div key={field.side} className="min-w-0 space-y-1.5">
            <div className="text-[13px] font-medium text-fg">{intl.formatMessage(field.title)}</div>
            <ResourceInput
              kind={kind}
              label={intl.formatMessage(field.label)}
              value={current[field.side]?.[kind] ?? "0"}
              min={0}
              max={max}
              onChange={(quantity) => onChange(setResource(current, kind, field.side, quantity))}
            />
            <p className="text-xs text-muted">{intl.formatMessage(field.hint)}</p>
            {field.side === "limits" && limit > 0 && (
              <Button variant="ghost" size="sm" onPress={() => onChange(setResource(current, kind, "limits", "0"))}>
                {intl.formatMessage(messages.removeLimit)}
              </Button>
            )}
          </div>
        ))}
      </div>

      <div className="space-y-1.5">
        <div className="h-2 overflow-hidden rounded-full bg-default">
          <div className={cn("h-full rounded-full", invalid ? "bg-danger" : "bg-accent")} style={{ width: `${fill}%` }} />
        </div>
        <p className={cn("text-xs", invalid ? "text-danger" : "text-muted")}>{summary}</p>
      </div>
    </section>
  );
}
