import { useState } from "react";
import { Button, Input } from "@heroui/react";
import { Plus } from "lucide-react";

import { SegmentedControl } from "@/components/statistics/SegmentedControl";
import { useOptionalIntl } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";
import type { PortAllocation } from "@/types";
import type { SectionProps } from "./types";

type Protocol = "TCP" | "UDP";

const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]{0,13}[a-z0-9])?$/;
const GRID = "@xl:grid @xl:grid-cols-[minmax(0,1fr)_72px_64px_minmax(0,1.4fr)_96px_64px] @xl:items-center @xl:gap-3";

export function AllocationsSection({ draft, onChange }: SectionProps) {
  const intl = useOptionalIntl();
  const allocations = draft.spec.networking?.allocations ?? [];
  const endpoints = draft.status?.allocationEndpoints ?? [];
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<Protocol>("UDP");
  const [port, setPort] = useState("");

  const portNumber = Number(port);
  const nameError = name && !NAME_PATTERN.test(name)
    ? intl.formatMessage({ id: "web.routes.tabs.settings.allocations.invalid_name", defaultMessage: "Use up to 15 lowercase letters, digits or dashes.", description: "Allocations: inline error under the name field when the name is not a valid port name" })
    : allocations.some((allocation) => allocation.name === name)
      ? intl.formatMessage({ id: "web.routes.tabs.settings.allocations.duplicate_name", defaultMessage: "An allocation with this name already exists.", description: "Allocations: inline error under the name field when another allocation already uses the name" })
      : null;
  const portError = port && (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535)
    ? intl.formatMessage({ id: "web.routes.tabs.settings.allocations.invalid_port", defaultMessage: "Port must be 1–65535.", description: "Allocations: inline error under the port field when the port is out of range" })
    : allocations.some((allocation) => allocation.port === portNumber && (allocation.protocol ?? "TCP") === protocol)
      ? intl.formatMessage({ id: "web.routes.tabs.settings.allocations.duplicate_port", defaultMessage: "This port is already allocated.", description: "Allocations: inline error under the port field when the same port and protocol is already allocated" })
      : null;
  const canAdd = name !== "" && port !== "" && !nameError && !portError;

  const setAllocations = (next: PortAllocation[]) => {
    onChange({
      ...draft,
      spec: {
        ...draft.spec,
        networking: { ...draft.spec.networking, allocations: next.length > 0 ? next : undefined },
      },
    });
  };

  const add = () => {
    setAllocations([...allocations, { name, port: portNumber, protocol }]);
    setName("");
    setPort("");
  };

  return (
    <div className="space-y-5">
      <section className="space-y-4 rounded-xl border border-border bg-card p-5">
        <div>
          <h3 className="text-[15px] font-semibold text-fg">{intl.formatMessage({ id: "web.routes.tabs.settings.allocations.allocated_ports", defaultMessage: "Allocated ports", description: "Allocations: title of the card listing the allocated ports" })}</h3>
          <p className="pt-1 text-[13px] text-muted">{intl.formatMessage({ id: "web.routes.tabs.settings.allocations.allocated_ports_hint", defaultMessage: "Each port gets its own LoadBalancer on the cluster's public IP and forwards to the same port in the pod.", description: "Allocations: hint under the Allocated ports title explaining how each allocation is exposed" })}</p>
        </div>

        {allocations.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted">{intl.formatMessage({ id: "web.routes.tabs.settings.allocations.empty", defaultMessage: "No extra ports allocated yet.", description: "Allocations: empty state shown when the server has no allocations" })}</p>
        ) : (
          <div className="@container overflow-hidden rounded-lg border border-border bg-background">
            <div className={cn("hidden border-b border-border bg-surface px-3.5 py-2 text-xs font-medium text-muted", GRID)}>
              <span>{intl.formatMessage({ id: "web.routes.tabs.settings.allocations.column_name", defaultMessage: "Name", description: "Allocations: column heading for the allocation name" })}</span>
              <span>{intl.formatMessage({ id: "web.routes.tabs.settings.allocations.column_protocol", defaultMessage: "Protocol", description: "Allocations: column heading for the TCP or UDP protocol" })}</span>
              <span>{intl.formatMessage({ id: "web.routes.tabs.settings.allocations.column_port", defaultMessage: "Port", description: "Allocations: column heading for the port number" })}</span>
              <span>{intl.formatMessage({ id: "web.routes.tabs.settings.allocations.column_address", defaultMessage: "Public address", description: "Allocations: column heading for the public IP and port players connect to" })}</span>
              <span>{intl.formatMessage({ id: "web.routes.tabs.settings.allocations.column_status", defaultMessage: "Status", description: "Allocations: column heading for whether the public address is assigned" })}</span>
              <span />
            </div>
            <div className="divide-y divide-border">
              {allocations.map((allocation) => {
                const host = endpoints.find((endpoint) => endpoint.name === allocation.name)?.host;
                const allocationProtocol: Protocol = allocation.protocol ?? "TCP";
                return (
                  <div key={allocation.name} className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3", GRID)}>
                    <span className="min-w-0 truncate text-[13px] font-medium text-fg">{allocation.name}</span>
                    <span className="w-fit rounded-md bg-default px-2 py-0.5 font-mono text-[11px] font-medium text-fg">{allocationProtocol}</span>
                    <span className="font-mono text-[13px] text-fg">{allocation.port}</span>
                    <span className={cn("min-w-0 truncate font-mono text-[13px]", host ? "text-fg" : "text-muted")}>
                      {host
                        ? intl.formatMessage({ id: "web.routes.tabs.settings.allocations.address", defaultMessage: "{host}:{port}", description: "Allocations: public address shown as host and port; keep the format" }, { host, port: allocation.port })
                        : intl.formatMessage({ id: "web.routes.tabs.settings.allocations.waiting", defaultMessage: "Waiting for address…", description: "Allocations: shown instead of the public address while it is not assigned yet" })}
                    </span>
                    <span className={cn("inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", host ? "bg-success/20 text-success" : "bg-warning/20 text-warning")}>
                      <span className={cn("h-1.5 w-1.5 rounded-full", host ? "bg-success" : "bg-warning")} />
                      {host
                        ? intl.formatMessage({ id: "web.routes.tabs.settings.allocations.assigned", defaultMessage: "Assigned", description: "Allocations: status badge when the public address is assigned" })
                        : intl.formatMessage({ id: "web.routes.tabs.settings.allocations.pending", defaultMessage: "Pending", description: "Allocations: status badge while the public address is not assigned yet" })}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto text-danger @xl:ml-0"
                      aria-label={intl.formatMessage({ id: "web.routes.tabs.settings.allocations.remove_named", defaultMessage: "Remove {name}", description: "Allocations: accessible name of the button that removes the allocation {name}" }, { name: allocation.name })}
                      onPress={() => setAllocations(allocations.filter((other) => other.name !== allocation.name))}
                    >
                      {intl.formatMessage({ id: "web.routes.tabs.settings.allocations.remove", defaultMessage: "Remove", description: "Allocations: button that removes an allocation row" })}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-xl border border-border bg-card p-5">
        <div>
          <h3 className="text-[15px] font-semibold text-fg">{intl.formatMessage({ id: "web.routes.tabs.settings.allocations.add_allocation", defaultMessage: "Add allocation", description: "Allocations: title of the card with the form that adds a port" })}</h3>
          <p className="pt-1 text-[13px] text-muted">{intl.formatMessage({ id: "web.routes.tabs.settings.allocations.add_allocation_hint", defaultMessage: "Use the same port in the plugin's config, e.g. port in voicechat-server.properties.", description: "Allocations: hint under the Add allocation title; voicechat-server.properties is a file name, keep it untranslated" })}</p>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <label className="block w-full space-y-1.5 sm:w-64">
            <span className="text-[13px] font-medium text-fg">{intl.formatMessage({ id: "web.routes.tabs.settings.allocations.name", defaultMessage: "Name", description: "Allocations: label of the allocation name field" })}</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value.trim())}
              placeholder={intl.formatMessage({ id: "web.routes.tabs.settings.allocations.name_placeholder", defaultMessage: "voicechat", description: "Allocations: example placeholder in the name field; an example value, not a default" })}
              spellCheck={false}
              className="w-full font-mono"
            />
            {nameError && <span className="block text-xs text-danger">{nameError}</span>}
          </label>
          <div className="space-y-1.5">
            <span className="block text-[13px] font-medium text-fg">{intl.formatMessage({ id: "web.routes.tabs.settings.allocations.protocol", defaultMessage: "Protocol", description: "Allocations: label of the TCP or UDP protocol switch" })}</span>
            <SegmentedControl<Protocol>
              ariaLabel={intl.formatMessage({ id: "web.routes.tabs.settings.allocations.protocol", defaultMessage: "Protocol", description: "Allocations: label of the TCP or UDP protocol switch" })}
              value={protocol}
              onChange={setProtocol}
              mono
              options={[
                { value: "TCP", label: intl.formatMessage({ id: "web.routes.tabs.settings.allocations.tcp", defaultMessage: "TCP", description: "Allocations: TCP protocol option; keep untranslated" }) },
                { value: "UDP", label: intl.formatMessage({ id: "web.routes.tabs.settings.allocations.udp", defaultMessage: "UDP", description: "Allocations: UDP protocol option; keep untranslated" }) },
              ]}
            />
          </div>
          <label className="block w-28 space-y-1.5 sm:w-36">
            <span className="text-[13px] font-medium text-fg">{intl.formatMessage({ id: "web.routes.tabs.settings.allocations.port", defaultMessage: "Port", description: "Allocations: label of the port number field" })}</span>
            <Input
              value={port}
              onChange={(event) => setPort(event.target.value.trim())}
              inputMode="numeric"
              placeholder={intl.formatMessage({ id: "web.routes.tabs.settings.allocations.port_placeholder", defaultMessage: "24454", description: "Allocations: example placeholder in the port field; an example port, not a default" })}
              className="w-full font-mono"
            />
            {portError && <span className="block text-xs text-danger">{portError}</span>}
          </label>
          <Button variant="secondary" className="mt-[22px]" isDisabled={!canAdd} onPress={add}>
            <Plus className="h-4 w-4" />
            {intl.formatMessage({ id: "web.routes.tabs.settings.allocations.add", defaultMessage: "Add", description: "Allocations: button that adds the allocation from the form" })}
          </Button>
        </div>
      </section>
    </div>
  );
}
