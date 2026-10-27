import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogContainer,
  Button,
  Card,
  Input,
  ListBox,
  ListBoxItem,
  Modal,
  ModalBody,
  ModalDialog,
  ModalFooter,
  ModalHeader,
  ModalHeading,
  Select,
} from "@heroui/react";
import { ArrowLeft, Check, Network as NetworkIcon, Plus, Trash2, X } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { PhaseChip } from "@/components/ui/PhaseChip";
import { NETWORK_ANNOTATION, OWNER_ANNOTATION } from "@/lib/annotations";
import { Networks, Servers, Users } from "@/lib/endpoints";
import { errorTextIntl } from "@/lib/errors";
import { targetKey, useFleetServers, type FleetItem } from "@/lib/fleet";
import { useOptionalIntl, useFormat } from "@/lib/i18n/format";
import { NETWORK_PERMISSIONS, PermissionChips, SERVER_PERMISSIONS } from "@/lib/permissions";
import type { GameServer, NetworkMember, User } from "@/types";

function networkOf(item: FleetItem<GameServer>): string {
  return item.resource.metadata.annotations?.[NETWORK_ANNOTATION] ?? "";
}

function initials(value: string): string {
  return value.slice(0, 2).toUpperCase();
}

export function NetworkDetailPage() {
  const intl = useOptionalIntl();
  const format = useFormat();
  const { name } = useParams({ from: "/app-layout/users/networks/$name" });
  const networks = useQuery({ queryKey: ["networks"], queryFn: () => Networks.list() });
  const users = useQuery({ queryKey: ["users"], queryFn: () => Users.list() });
  const fleet = useFleetServers();
  const network = networks.data?.find((candidate) => candidate.name === name);
  const items = fleet.data?.items ?? [];
  const servers = items.filter((item) => networkOf(item) === name);

  if (networks.isPending) return null;

  return (
    <div className="space-y-6 p-6">
      <Link to="/users" search={{ tab: "networks" }} className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {intl.formatMessage({ id: "web.routes.network_detail.back_to_networks", defaultMessage: "Networks", description: "Network detail: back link above the page title that returns to the Networks tab; keep it short" })}
      </Link>
      {!network ? (
        <Card className="border border-border">
          <EmptyState icon={<NetworkIcon />} title={intl.formatMessage({ id: "web.routes.network_detail.not_found", defaultMessage: "Network not found", description: "Network detail: title of the empty state shown when no network matches the URL" })} />
        </Card>
      ) : (
        <>
          <PageHeader
            title={<span className="font-mono">{network.name}</span>}
            description={intl.formatMessage({ id: "web.routes.network_detail.description", defaultMessage: "Servers assigned to this network and the members who can reach them.", description: "Network detail: description under the network name in the page header" })}
          />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
            <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
              <Card className="flex flex-col gap-4 border border-border p-5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/10 font-mono text-base font-semibold text-accent">{initials(network.name)}</span>
                  <p className="truncate font-mono text-sm font-medium">{network.name}</p>
                </div>
                <dl className="grid grid-cols-2 gap-3 text-xs text-muted">
                  <div>
                    <dt>{intl.formatMessage({ id: "web.routes.network_detail.servers", defaultMessage: "Servers", description: "Network detail: section title of the servers card and its navigation link; keep it short" })}</dt>
                    <dd className="text-base font-semibold text-foreground">{format.number(servers.length)}</dd>
                  </div>
                  <div>
                    <dt>{intl.formatMessage({ id: "web.routes.network_detail.members", defaultMessage: "Members", description: "Network detail: section title of the members card and its navigation link; keep it short" })}</dt>
                    <dd className="text-base font-semibold text-foreground">{format.number(network.members.length)}</dd>
                  </div>
                </dl>
              </Card>
              <nav aria-label={intl.formatMessage({ id: "web.routes.network_detail.sections", defaultMessage: "Network sections", description: "Network detail: accessible name of the section navigation in the sidebar; not visible on screen" })} className="flex gap-1 overflow-x-auto text-sm lg:flex-col">
                <a href="#servers" className="shrink-0 rounded-lg px-3 py-2 text-muted hover:bg-default/60 hover:text-foreground">
                  {intl.formatMessage({ id: "web.routes.network_detail.servers", defaultMessage: "Servers", description: "Network detail: section title of the servers card and its navigation link; keep it short" })}
                </a>
                <a href="#members" className="shrink-0 rounded-lg px-3 py-2 text-muted hover:bg-default/60 hover:text-foreground">
                  {intl.formatMessage({ id: "web.routes.network_detail.members", defaultMessage: "Members", description: "Network detail: section title of the members card and its navigation link; keep it short" })}
                </a>
                <a href="#danger" className="shrink-0 rounded-lg px-3 py-2 text-muted hover:bg-default/60 hover:text-foreground">
                  {intl.formatMessage({ id: "web.routes.network_detail.danger_zone", defaultMessage: "Danger zone", description: "Network detail: title of the danger zone card and its navigation link; keep it short" })}
                </a>
              </nav>
            </aside>
            <div className="flex min-w-0 flex-col gap-6">
              <ServersCard name={network.name} servers={servers} items={items} />
              <MembersCard name={network.name} members={network.members} users={users.data ?? []} />
              <DangerCard name={network.name} servers={servers} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ServersCard({ name, servers, items }: { name: string; servers: FleetItem<GameServer>[]; items: FleetItem<GameServer>[] }) {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<FleetItem<GameServer>[]>([]);
  const candidates = items.filter((item) => networkOf(item) !== name && item.target.name.toLowerCase().includes(search.trim().toLowerCase()));
  const refresh = () => qc.invalidateQueries({ queryKey: ["fleet", "servers"] });
  const add = useMutation({
    mutationFn: () => Promise.all(selected.map((item) => Servers.setNetwork(item.target.name, item.target.namespace, name, item.target.cluster))),
    onSuccess: async () => {
      setSelected([]);
      setAdding(false);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (item: FleetItem<GameServer>) => Servers.setNetwork(item.target.name, item.target.namespace, "", item.target.cluster),
    onSuccess: refresh,
  });
  const toggle = (item: FleetItem<GameServer>) => {
    const key = targetKey(item.target);
    setSelected((current) => current.some((candidate) => targetKey(candidate.target) === key)
      ? current.filter((candidate) => targetKey(candidate.target) !== key)
      : [...current, item]);
  };

  return (
    <Card id="servers" className="flex scroll-mt-6 flex-col border border-border">
      <SectionHeader
        title={intl.formatMessage({ id: "web.routes.network_detail.servers", defaultMessage: "Servers", description: "Network detail: section title of the servers card and its navigation link; keep it short" })}
        description={intl.formatMessage({ id: "web.routes.network_detail.servers_description", defaultMessage: "Servers in this network share its members' access.", description: "Network detail: description under the Servers section title" })}
        action={
          <Button size="sm" variant="outline" onPress={() => setAdding((open) => !open)}>
            <Plus className="h-3.5 w-3.5" /> {intl.formatMessage({ id: "web.routes.network_detail.add_servers", defaultMessage: "Add servers", description: "Network detail: button that opens the picker for assigning fleet servers to this network; keep it short" })}
          </Button>
        }
      />
      {adding && (
        <div className="flex flex-col gap-3 border-b border-border p-4">
          <Input
            aria-label={intl.formatMessage({ id: "web.routes.network_detail.search_servers", defaultMessage: "Search servers", description: "Network detail: accessible name of the search input in the add-servers picker" })}
            placeholder={intl.formatMessage({ id: "web.routes.network_detail.search_servers_placeholder", defaultMessage: "Search servers…", description: "Network detail: placeholder of the search input in the add-servers picker" })}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {selected.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {selected.map((item) => (
                <button
                  key={targetKey(item.target)}
                  type="button"
                  onClick={() => toggle(item)}
                  aria-label={intl.formatMessage({ id: "web.routes.network_detail.remove_from_selection", defaultMessage: "Remove {name} from selection", description: "Network detail: accessible name of the chip that removes a server from the add-servers selection; {name} is the server name" }, { name: item.target.name })}
                  className="inline-flex h-7 items-center gap-1 rounded-full bg-accent/10 px-2.5 font-mono text-xs text-accent"
                >
                  {item.target.name}
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
          <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {candidates.map((item) => {
              const isSelected = selected.some((candidate) => targetKey(candidate.target) === targetKey(item.target));
              const current = networkOf(item);
              return (
                <li key={targetKey(item.target)}>
                  <button type="button" aria-pressed={isSelected} onClick={() => toggle(item)} className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-default/40">
                    <span className="truncate font-mono text-xs">{item.target.name}</span>
                    <span className="flex items-center gap-2 text-xs text-muted">
                      {current || intl.formatMessage({ id: "web.routes.network_detail.unassigned", defaultMessage: "Unassigned", description: "Network detail: label in the add-servers picker for a server that belongs to no network" })}
                      {isSelected ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onPress={() => { setSelected([]); setAdding(false); }} isDisabled={add.isPending}>
              {intl.formatMessage({ id: "web.routes.network_detail.cancel", defaultMessage: "Cancel", description: "Network detail: button that closes the add-servers picker without assigning anything; keep it short" })}
            </Button>
            <Button variant="primary" size="sm" onPress={() => add.mutate()} isDisabled={selected.length === 0 || add.isPending}>
              {intl.formatMessage({ id: "web.routes.network_detail.add_count_servers", defaultMessage: "Add {count, plural, one {# server} other {# servers}}", description: "Network detail: button that assigns the selected servers to the network; {count} is the number of selected servers" }, { count: selected.length })}
            </Button>
          </div>
          <ErrorText error={add.error} />
        </div>
      )}
      {servers.length === 0 ? (
        <EmptyState icon={<NetworkIcon />} title={intl.formatMessage({ id: "web.routes.network_detail.no_servers", defaultMessage: "No servers in this network yet.", description: "Network detail: empty state of the servers card when no server is assigned to the network" })} />
      ) : (
        <ul className="divide-y divide-border">
          {servers.map((item) => (
            <li key={targetKey(item.target)} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm">{item.target.name}</p>
                <p className="truncate text-xs text-muted">
                  {item.resource.metadata.annotations?.[OWNER_ANNOTATION] || intl.formatMessage({ id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" })}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <PhaseChip phase={item.resource.status?.phase} />
                <Button isIconOnly variant="ghost" size="sm" className="text-danger" aria-label={intl.formatMessage({ id: "web.routes.network_detail.remove_server", defaultMessage: "Remove {name} from network", description: "Network detail: accessible name of the button that removes a server from the network; {name} is the server name" }, { name: item.target.name })} onPress={() => remove.mutate(item)} isDisabled={remove.isPending}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="px-4 pb-2">
        <ErrorText error={remove.error} />
      </div>
    </Card>
  );
}

function MembersCard({ name, members, users }: { name: string; members: NetworkMember[]; users: User[] }) {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const [memberId, setMemberId] = useState("");
  const [permissions, setPermissions] = useState(SERVER_PERMISSIONS.map((permission) => permission.key));
  const available = users.filter((user) => !members.some((member) => member.id === user.id));
  const refresh = () => qc.invalidateQueries({ queryKey: ["networks"] });
  const add = useMutation({
    mutationFn: () => Networks.addMember(name, Number(memberId), permissions),
    onSuccess: async () => {
      setMemberId("");
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, granted }: { id: number; granted: string[] }) => Networks.addMember(name, id, granted),
    onSuccess: refresh,
  });
  const removeMember = useMutation({
    mutationFn: (id: number) => Networks.removeMember(name, id),
    onSuccess: refresh,
  });

  return (
    <Card id="members" className="flex scroll-mt-6 flex-col border border-border">
      <SectionHeader
        title={intl.formatMessage({ id: "web.routes.network_detail.members", defaultMessage: "Members", description: "Network detail: section title of the members card and its navigation link; keep it short" })}
        description={intl.formatMessage({ id: "web.routes.network_detail.members_description", defaultMessage: "Members can view every server in this network. Console and Manage are granted per member.", description: "Network detail: description under the Members section title" })}
      />
      {members.length === 0 ? (
        <EmptyState icon={<NetworkIcon />} title={intl.formatMessage({ id: "web.routes.network_detail.no_members", defaultMessage: "No members yet.", description: "Network detail: empty state of the members card when the network has no members" })} />
      ) : (
        <ul className="divide-y divide-border">
          {members.map((member) => {
            const user = users.find((candidate) => candidate.id === member.id);
            return (
              <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-default/60 font-mono text-xs font-semibold">{initials(member.username)}</span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{user?.displayName || member.username}</p>
                    <p className="truncate font-mono text-xs text-muted">
                      {intl.formatMessage({ id: "web.routes.network_detail.username_handle", defaultMessage: "@{username}", description: "Network detail: username shown under a member's name, prefixed with an at sign; {username} is the login name" }, { username: member.username })}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {user?.role && <span className="rounded-full bg-default/60 px-2 py-0.5 text-[11px] text-muted">{user.role}</span>}
                  <PermissionChips
                    label={intl.formatMessage({ id: "web.routes.network_detail.member_permissions", defaultMessage: "{username} permissions in {network}", description: "Network detail: accessible name of the permission chips for one member of the network; {username} is the member and {network} the network name" }, { username: member.username, network: name })}
                    permissions={NETWORK_PERMISSIONS}
                    value={member.permissions}
                    onChange={(granted) => update.mutate({ id: member.id, granted })}
                    isDisabled={update.isPending}
                  />
                  <Button isIconOnly variant="ghost" size="sm" className="text-danger" aria-label={intl.formatMessage({ id: "web.routes.network_detail.remove_member", defaultMessage: "Remove {username} from {network}", description: "Network detail: accessible name of the button that removes a member from the network; {username} is the member and {network} the network name" }, { username: member.username, network: name })} onPress={() => removeMember.mutate(member.id)} isDisabled={removeMember.isPending}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-col gap-3 border-t border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={intl.formatMessage({ id: "web.routes.network_detail.member_to_add", defaultMessage: "User to add", description: "Network detail: accessible name of the dropdown that picks a user to add to the network" })}
            placeholder={intl.formatMessage({ id: "web.routes.network_detail.choose_user", defaultMessage: "Choose a user", description: "Network detail: placeholder of the dropdown that picks a user to add to the network" })}
            value={memberId}
            onChange={(value) => setMemberId(String(value))}
            className="min-w-48 flex-1"
          >
            <Select.Trigger className="w-full items-center rounded border border-border bg-surface px-3 py-2 text-sm hover:bg-surface/80">
              <Select.Value className="text-[var(--field-placeholder)]" />
              <Select.Indicator className="ml-auto h-4 w-4" />
            </Select.Trigger>
            <Select.Popover className="rounded border border-border">
              <ListBox className="p-0" aria-label={intl.formatMessage({ id: "web.routes.network_detail.member_to_add", defaultMessage: "User to add", description: "Network detail: accessible name of the dropdown that picks a user to add to the network" })}>
                {available.map((user) => (
                  <ListBoxItem key={user.id} id={String(user.id)}>{user.username}</ListBoxItem>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <Button size="sm" variant="primary" onPress={() => add.mutate()} isDisabled={!memberId || add.isPending}>
            <Plus className="h-3.5 w-3.5" /> {intl.formatMessage({ id: "web.routes.network_detail.add_member", defaultMessage: "Add member", description: "Network detail: button that adds the selected user to the network; keep it short" })}
          </Button>
        </div>
        <PermissionChips
          label={intl.formatMessage({ id: "web.routes.network_detail.new_member_permissions", defaultMessage: "New member permissions in {network}", description: "Network detail: accessible name of the permission chips for a member about to be added to the network; {network} is the network name" }, { network: name })}
          permissions={NETWORK_PERMISSIONS}
          value={permissions}
          onChange={setPermissions}
        />
        <ErrorText error={add.error ?? update.error ?? removeMember.error} />
      </div>
    </Card>
  );
}

function DangerCard({ name, servers }: { name: string; servers: FleetItem<GameServer>[] }) {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: async () => {
      await Promise.all(servers.map((item) => Servers.setNetwork(item.target.name, item.target.namespace, "", item.target.cluster)));
      await Networks.remove(name);
    },
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ["networks"] }), qc.invalidateQueries({ queryKey: ["fleet", "servers"] })]);
      void navigate({ to: "/users", search: { tab: "networks" } });
    },
  });

  return (
    <Card id="danger" className="flex scroll-mt-6 flex-col border border-danger/40">
      <SectionHeader
        title={intl.formatMessage({ id: "web.routes.network_detail.danger_zone", defaultMessage: "Danger zone", description: "Network detail: title of the danger zone card and its navigation link; keep it short" })}
        description={intl.formatMessage({ id: "web.routes.network_detail.delete_description", defaultMessage: "Deleting the network unassigns its servers and removes every member.", description: "Network detail: explanation under the danger zone title of what deleting the network does" })}
      />
      <div className="px-4 py-3">
        <Button variant="danger" size="sm" onPress={() => setConfirming(true)}>
          <Trash2 className="h-3.5 w-3.5" /> {intl.formatMessage({ id: "web.routes.network_detail.delete_network", defaultMessage: "Delete network", description: "Network detail: button that opens the confirmation dialog for deleting the network; keep it short" })}
        </Button>
      </div>
      {confirming && (
        <AlertDialog isOpen onOpenChange={(open) => !open && setConfirming(false)}>
          <AlertDialogBackdrop isDismissable={!remove.isPending} isKeyboardDismissDisabled={remove.isPending}>
            <AlertDialogContainer>
              <Modal>
                <ModalDialog role="alertdialog" className="max-w-md">
                  <ModalHeader>
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger"><Trash2 className="h-5 w-5" /></span>
                    <ModalHeading>{intl.formatMessage({ id: "web.routes.network_detail.delete_name", defaultMessage: "Delete {name}?", description: "Network detail: heading of the delete confirmation dialog; {name} is the network name" }, { name })}</ModalHeading>
                  </ModalHeader>
                  <ModalBody>
                    <p className="text-sm">
                      {intl.formatMessage({ id: "web.routes.network_detail.delete_confirm", defaultMessage: "{count, plural, one {# server} other {# servers}} will be unassigned and every member will lose access through this network. This cannot be undone.", description: "Network detail: body of the delete confirmation dialog; {count} is the number of servers that will be unassigned" }, { count: servers.length })}
                    </p>
                    <ErrorText error={remove.error} />
                  </ModalBody>
                  <ModalFooter className="flex items-center justify-end gap-2">
                    <Button variant="ghost" size="sm" onPress={() => setConfirming(false)} isDisabled={remove.isPending}>
                      {intl.formatMessage({ id: "web.routes.network_detail.cancel_delete", defaultMessage: "Cancel", description: "Network detail: button that closes the delete confirmation dialog without deleting the network; keep it short" })}
                    </Button>
                    <Button variant="danger" size="sm" onPress={() => remove.mutate()} isDisabled={remove.isPending}>
                      {intl.formatMessage({ id: "web.routes.network_detail.confirm_delete", defaultMessage: "Delete network", description: "Network detail: button that confirms deleting the network in the confirmation dialog; keep it short" })}
                    </Button>
                  </ModalFooter>
                </ModalDialog>
              </Modal>
            </AlertDialogContainer>
          </AlertDialogBackdrop>
        </AlertDialog>
      )}
    </Card>
  );
}

function SectionHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

function ErrorText({ error }: { error: unknown }) {
  const intl = useOptionalIntl();
  if (!error) return null;
  return (
    <p role="alert" className="text-xs text-danger">
      {errorTextIntl(intl, error, intl.formatMessage({ id: "web.routes.network_detail.request_failed", defaultMessage: "Request failed", description: "Network detail: fallback error shown when a network request fails without a readable message" }))}
    </p>
  );
}
