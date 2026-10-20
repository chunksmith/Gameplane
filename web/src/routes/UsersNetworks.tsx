import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Button,
  Card,
  Input,
  Label,
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContainer,
  ModalDialog,
  ModalFooter,
  ModalHeader,
  ModalHeading,
} from "@heroui/react";
import { ChevronRight, Network as NetworkIcon, Plus, Search } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Chip } from "@/components/ui/PhaseChip";
import { useMe, can } from "@/lib/auth";
import { NETWORK_ANNOTATION } from "@/lib/annotations";
import { Networks } from "@/lib/endpoints";
import { errorTextIntl } from "@/lib/errors";
import { targetKey, useFleetServers, type FleetItem } from "@/lib/fleet";
import { useOptionalIntl } from "@/lib/i18n/format";
import type { GameServer, Network } from "@/types";

const MAX_SERVER_CHIPS = 4;

export function NetworksTab() {
  const intl = useOptionalIntl();
  const { data: me } = useMe();
  const canManage = can(me, "users:manage");
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const { data: networks = [], error } = useQuery({ queryKey: ["networks"], queryFn: () => Networks.list() });
  const { data: fleet } = useFleetServers();
  const items = fleet?.items ?? [];
  const visible = networks.filter((network) => network.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-xs text-muted">
        {intl.formatMessage({ id: "web.routes.users_networks.members_can_view_every_server_assigned", defaultMessage: "Members can view every server assigned to their network. Console and Manage (start, stop, files, mods and players) are granted per member. Delete, transfer and wipe stay with the owner.", description: "Users networks: explanation at the top of the networks tab saying what members can view and which permissions are granted per member, and that only the owner can delete, transfer or wipe" })}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          aria-label={intl.formatMessage({ id: "web.routes.users_networks.search_networks", defaultMessage: "Search networks", description: "Users networks: accessible name of the search input that filters the network cards by name" })}
          placeholder={intl.formatMessage({ id: "web.routes.users_networks.search_networks_placeholder", defaultMessage: "Search networks…", description: "Users networks: placeholder of the search input that filters the network cards by name" })}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full max-w-xs"
        />
        {canManage && (
          <Button variant="primary" onPress={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> {intl.formatMessage({ id: "web.routes.users_networks.new_network", defaultMessage: "New network", description: "Users networks: button and dialog heading for creating a new network; keep it short" })}
          </Button>
        )}
      </div>
      <ErrorText error={error} />
      {networks.length === 0 ? (
        <Card className="border border-border"><EmptyState icon={<NetworkIcon />} title={intl.formatMessage({ id: "web.routes.users_networks.no_networks_yet", defaultMessage: "No networks yet.", description: "Users networks: title of the empty state shown when there are no networks" })} /></Card>
      ) : visible.length === 0 ? (
        <Card className="border border-border"><EmptyState icon={<Search />} title={intl.formatMessage({ id: "web.routes.users_networks.no_networks_match", defaultMessage: "No networks match your search.", description: "Users networks: title of the empty state shown when the search matches no network name" })} /></Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((network) => (
            <NetworkCard key={network.name} network={network} servers={items.filter((item) => networkOf(item) === network.name)} />
          ))}
        </div>
      )}
      {creating && <CreateNetworkDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function networkOf(item: FleetItem<GameServer>): string {
  return item.resource.metadata.annotations?.[NETWORK_ANNOTATION] ?? "";
}

function CreateNetworkDialog({ onClose }: { onClose: () => void }) {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => Networks.create(name.trim()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["networks"] });
      onClose();
    },
  });
  const submit = () => {
    if (name.trim() && !create.isPending) create.mutate();
  };

  return (
    <Modal isOpen onOpenChange={(open) => !open && onClose()}>
      <ModalBackdrop isDismissable={!create.isPending} isKeyboardDismissDisabled={create.isPending}>
        <ModalContainer>
          <ModalDialog className="w-full max-w-[420px]">
            <ModalHeader>
              <ModalHeading>{intl.formatMessage({ id: "web.routes.users_networks.new_network", defaultMessage: "New network", description: "Users networks: button and dialog heading for creating a new network; keep it short" })}</ModalHeading>
            </ModalHeader>
            <ModalBody className="gap-1.5">
              <Label htmlFor="network-name" className="text-xs">
                {intl.formatMessage({ id: "web.routes.users_networks.network_name", defaultMessage: "Network name", description: "Users networks: label of the input for the name of the new network" })}
              </Label>
              <Input
                id="network-name"
                placeholder={intl.formatMessage({ id: "web.routes.users_networks.e_g_survival", defaultMessage: "e.g. survival", description: "Users networks: example network name shown as the placeholder of the network name input" })}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
              <ErrorText error={create.error} />
            </ModalBody>
            <ModalFooter className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onPress={onClose} isDisabled={create.isPending}>
                {intl.formatMessage({ id: "web.routes.users_networks.cancel", defaultMessage: "Cancel", description: "Users networks: button that closes the dialog without creating the network; keep it short" })}
              </Button>
              <Button variant="primary" size="sm" onPress={submit} isDisabled={!name.trim() || create.isPending}>
                {intl.formatMessage({ id: "web.routes.users_networks.create", defaultMessage: "Create", description: "Users networks: button that creates the network named in the dialog; keep it short" })}
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}

function NetworkCard({ network, servers }: { network: Network; servers: FleetItem<GameServer>[] }) {
  const intl = useOptionalIntl();
  const shown = servers.slice(0, MAX_SERVER_CHIPS);
  const hidden = servers.length - shown.length;

  return (
    <Card className="flex flex-col gap-4 border border-border p-5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 font-mono text-sm font-semibold text-accent">
          {network.name.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0">
          <Link to="/users/networks/$name" params={{ name: network.name }} className="block truncate font-mono text-sm font-medium hover:text-accent">{network.name}</Link>
          <p className="text-xs text-muted">
            {intl.formatMessage({ id: "web.routes.users_networks.count_server", defaultMessage: "{count, plural, one {# server} other {# servers}}", description: "Users networks: server count on a network card; {count} is the number of fleet servers assigned to the network" }, { count: servers.length })}
          </p>
        </div>
      </div>
      <div className="flex min-h-7 flex-wrap items-center gap-1.5">
        {servers.length === 0 ? (
          <Link to="/users/networks/$name" params={{ name: network.name }} className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-xs text-muted hover:text-foreground">
            <Plus className="h-3 w-3" aria-hidden="true" />
            {intl.formatMessage({ id: "web.routes.users_networks.add_servers", defaultMessage: "Add servers", description: "Users networks: chip on an empty network card that links to the network detail page to assign servers; keep it short" })}
          </Link>
        ) : (
          <>
            {shown.map((item) => (
              <Chip key={targetKey(item.target)}>{item.target.name}</Chip>
            ))}
            {hidden > 0 && (
              <Chip>{intl.formatMessage({ id: "web.routes.users_networks.more_servers", defaultMessage: "+{count}", description: "Users networks: chip after the server names on a network card showing how many more servers are assigned; {count} is that number" }, { count: hidden })}</Chip>
            )}
          </>
        )}
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted">
        <span>
          {intl.formatMessage({ id: "web.routes.users_networks.count_member", defaultMessage: "{count, plural, one {# member} other {# members}}", description: "Users networks: member count badge on a network card; {count} is the number of members" }, { count: network.members.length })}
        </span>
        <Link to="/users/networks/$name" params={{ name: network.name }} className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline">
          {intl.formatMessage({ id: "web.routes.users_networks.manage", defaultMessage: "Manage", description: "Users networks: link on a network card that opens the network detail page to edit its servers and members; keep it short" })}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>
    </Card>
  );
}

function ErrorText({ error }: { error: unknown }) {
  const intl = useOptionalIntl();
  if (!error) return null;
  return (
    <p role="alert" className="text-xs text-danger">
      {errorTextIntl(intl, error, intl.formatMessage({ id: "web.routes.users_networks.request_failed", defaultMessage: "Request failed", description: "Users networks: fallback error shown when a network request fails without a readable message" }))}
    </p>
  );
}
