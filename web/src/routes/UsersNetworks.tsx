import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  Checkbox,
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
import { Network as NetworkIcon, Plus, Trash2, X } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { useMe, can } from "@/lib/auth";
import { Networks, Users } from "@/lib/endpoints";
import { errorTextIntl } from "@/lib/errors";
import type { ExtendedUser, Network } from "@/types";
import { useOptionalIntl } from "@/lib/i18n/format";
import { defineMessages, type IntlShape } from "react-intl";

const NETWORK_PERMISSION_MESSAGES = defineMessages({
  console: { id: "web.routes.users_networks.permission_console", defaultMessage: "Console", description: "Users networks: name of the console permission, shown as a checkbox and in the member summary; keep it short" },
  manage: { id: "web.routes.users_networks.permission_manage", defaultMessage: "Manage", description: "Users networks: name of the permission that lets a member start, stop, change files, mods and players of a server, shown as a checkbox and in the member summary; keep it short" },
});

const NETWORK_PERMISSIONS = [
  { key: "servers:console", label: NETWORK_PERMISSION_MESSAGES.console },
  { key: "servers:write", label: NETWORK_PERMISSION_MESSAGES.manage },
];

export function NetworksTab() {
  const intl = useOptionalIntl();
  const { data: me } = useMe();
  const canManage = can(me, "users:manage");
  const [creating, setCreating] = useState(false);
  const { data: networks = [], error } = useQuery({ queryKey: ["networks"], queryFn: () => Networks.list() });
  const { data: users = [] } = useQuery({ queryKey: ["users"], queryFn: () => Users.list() });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="max-w-2xl text-xs text-muted">
          {intl.formatMessage({ id: "web.routes.users_networks.members_can_view_every_server_assigned", defaultMessage: "Members can view every server assigned to their network. Console and Manage (start, stop, files, mods and players) are granted per member. Delete, transfer and wipe stay with the owner.", description: "Users networks: explanation at the top of the networks tab saying what members can view and which permissions are granted per member, and that only the owner can delete, transfer or wipe" })}
        </p>
        {canManage && (
          <Button variant="primary" onPress={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> {intl.formatMessage({ id: "web.routes.users_networks.new_network", defaultMessage: "New network", description: "Users networks: button and dialog heading for creating a new network; keep it short" })}
          </Button>
        )}
      </div>
      <ErrorText error={error} />
      {networks.length === 0 ? (
        <Card className="border border-border"><EmptyState icon={<NetworkIcon />} title={intl.formatMessage({ id: "web.routes.users_networks.no_networks_yet", defaultMessage: "No networks yet.", description: "Users networks: title of the empty state shown when there are no networks" })} /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {networks.map((network) => (
            <NetworkCard key={network.name} network={network} users={users} canManage={canManage} />
          ))}
        </div>
      )}
      {creating && <CreateNetworkDialog onClose={() => setCreating(false)} />}
    </div>
  );
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

function NetworkCard({ network, users, canManage }: { network: Network; users: ExtendedUser[]; canManage: boolean }) {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [permissions, setPermissions] = useState(NETWORK_PERMISSIONS.map((permission) => permission.key));
  const [confirming, setConfirming] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["networks"] });
  const add = useMutation({
    mutationFn: async () => {
      const user = users.find((candidate) => candidate.username === username.trim());
      if (!user) throw new Error(intl.formatMessage({ id: "web.routes.users_networks.user_not_found", defaultMessage: "User {username} not found", description: "Users networks: error shown when the username typed to add a member matches no user; {username} is the typed name" }, { username: username.trim() }));
      return Networks.addMember(network.name, user.id, permissions);
    },
    onSuccess: () => {
      setUsername("");
      return refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, granted }: { id: number; granted: string[] }) => Networks.addMember(network.name, id, granted),
    onSuccess: refresh,
  });
  const removeMember = useMutation({
    mutationFn: (id: number) => Networks.removeMember(network.name, id),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => Networks.remove(network.name),
    onSuccess: refresh,
  });
  const count = network.members.length;

  return (
    <Card className="flex flex-col gap-3 border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"><NetworkIcon className="h-4 w-4" /></span>
          <span className="truncate font-mono text-sm font-medium">{network.name}</span>
          <span className="shrink-0 rounded-full bg-default/60 px-2 py-0.5 text-[11px] text-muted">
            {intl.formatMessage({ id: "web.routes.users_networks.count_member", defaultMessage: "{count, plural, one {# member} other {# members}}", description: "Users networks: member count badge on a network card; {count} is the number of members" }, { count: count })}
          </span>
        </div>
        {canManage && (
          <Button
            size="sm"
            variant="danger"
            onPress={() => (confirming ? remove.mutate() : setConfirming(true))}
            isDisabled={remove.isPending}
          >
            <Trash2 className="h-3.5 w-3.5" /> {confirming
              ? intl.formatMessage({ id: "web.routes.users_networks.confirm_delete", defaultMessage: "Confirm delete", description: "Users networks: label of the delete button after the first click, asking the owner to confirm; keep it short" })
              : intl.formatMessage({ id: "web.routes.users_networks.delete", defaultMessage: "Delete", description: "Users networks: button that starts deleting the network; the next click confirms it; keep it short" })}
          </Button>
        )}
      </div>
      {count > 0 ? (
        <ul className="divide-y divide-border">
          {network.members.map((member) => (
            <li key={member.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="font-mono text-xs">{member.username}</span>
              <div className="flex items-center gap-2">
                {canManage ? (
                  <PermissionPicker
                    label={intl.formatMessage({ id: "web.routes.users_networks.member_permissions_in_network", defaultMessage: "{username} permissions in {network}", description: "Users networks: accessible name of the group of permission checkboxes for one member of a network; {username} is the member and {network} the network name" }, { username: member.username, network: network.name })}
                    value={member.permissions}
                    onChange={(granted) => update.mutate({ id: member.id, granted })}
                    isDisabled={update.isPending}
                  />
                ) : (
                  <span className="text-xs text-muted">{permissionSummary(member.permissions, intl)}</span>
                )}
                {canManage && (
                  <Button
                    isIconOnly
                    variant="ghost"
                    size="sm"
                    className="text-danger"
                    aria-label={intl.formatMessage({ id: "web.routes.users_networks.remove_member_from_network", defaultMessage: "Remove {username} from {network}", description: "Users networks: accessible name of the icon button that removes a member from the network; {username} is the member and {network} the network name" }, { username: member.username, network: network.name })}
                    onPress={() => removeMember.mutate(member.id)}
                    isDisabled={removeMember.isPending}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted">{intl.formatMessage({ id: "web.routes.users_networks.no_members_yet", defaultMessage: "No members yet", description: "Users networks: text shown in a network card when the network has no members" })}</p>
      )}
      {canManage && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input
              aria-label={intl.formatMessage({ id: "web.routes.users_networks.add_member_to_network", defaultMessage: "Add member to {network}", description: "Users networks: accessible name of the input that adds a member to the network; {network} is the network name" }, { network: network.name })}
              placeholder={intl.formatMessage({ id: "web.routes.users_networks.add_member_by_username", defaultMessage: "Add member by username…", description: "Users networks: placeholder of the input that takes the username of a member to add to the network" })}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && username.trim()) add.mutate();
              }}
              className="flex-1"
            />
            <Button size="sm" variant="outline" onPress={() => add.mutate()} isDisabled={!username.trim() || add.isPending}>
              <Plus className="h-3.5 w-3.5" /> {intl.formatMessage({ id: "web.routes.users_networks.add", defaultMessage: "Add", description: "Users networks: button that adds the typed username as a member of the network; keep it short" })}
            </Button>
          </div>
          <PermissionPicker
            label={intl.formatMessage({ id: "web.routes.users_networks.new_member_permissions_in_network", defaultMessage: "New member permissions in {network}", description: "Users networks: accessible name of the permission checkboxes for a member about to be added to the network; {network} is the network name" }, { network: network.name })}
            value={permissions}
            onChange={setPermissions}
          />
        </div>
      )}
      <ErrorText error={add.error ?? update.error ?? removeMember.error ?? remove.error} />
    </Card>
  );
}

function PermissionPicker({
  label,
  value,
  onChange,
  isDisabled,
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  isDisabled?: boolean;
}) {
  const intl = useOptionalIntl();
  return (
    <div role="group" aria-label={label} className="flex items-center gap-3">
      {NETWORK_PERMISSIONS.map((permission) => (
        <Checkbox
          key={permission.key}
          isSelected={value.includes(permission.key)}
          onChange={(selected) =>
            onChange(selected ? [...value, permission.key] : value.filter((key) => key !== permission.key))
          }
          isDisabled={isDisabled}
          className="flex-row items-center gap-1.5"
        >
          <Checkbox.Control className="size-4">
            <Checkbox.Indicator />
          </Checkbox.Control>
          <Checkbox.Content>
            <span className="text-xs">{intl.formatMessage(permission.label)}</span>
          </Checkbox.Content>
        </Checkbox>
      ))}
    </div>
  );
}

function permissionSummary(granted: string[], intl: IntlShape) {
  return (
    NETWORK_PERMISSIONS.filter((permission) => granted.includes(permission.key))
      .map((permission) => intl.formatMessage(permission.label))
      .join(", ") || intl.formatMessage({ id: "web.routes.users_networks.view_only", defaultMessage: "View only", description: "Users networks: summary of a member with no permissions on the network, so the member can only view it; keep it short" })
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
