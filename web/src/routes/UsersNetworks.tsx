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
import { Plus, Trash2, X } from "lucide-react";
import { useMe, can } from "@/lib/auth";
import { Networks, Users } from "@/lib/endpoints";
import { errorText } from "@/lib/errors";
import type { ExtendedUser, Network } from "@/types";

const NETWORK_PERMISSIONS = [
  { key: "servers:console", label: "Console" },
  { key: "servers:write", label: "Manage" },
];

export function NetworksTab() {
  const { data: me } = useMe();
  const canManage = can(me, "users:manage");
  const [creating, setCreating] = useState(false);
  const { data: networks = [], error } = useQuery({ queryKey: ["networks"], queryFn: () => Networks.list() });
  const { data: users = [] } = useQuery({ queryKey: ["users"], queryFn: () => Users.list() });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="max-w-2xl text-xs text-foreground/60">
          Members can view every server assigned to their network. Console and Manage (start, stop, files, mods and
          players) are granted per member. Delete, transfer and wipe stay with the owner.
        </p>
        {canManage && (
          <Button variant="primary" onPress={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New network
          </Button>
        )}
      </div>
      <ErrorText error={error} />
      {networks.length === 0 ? (
        <p className="text-sm text-foreground/60">No networks yet.</p>
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
              <ModalHeading>New network</ModalHeading>
            </ModalHeader>
            <ModalBody className="gap-1.5">
              <Label htmlFor="network-name" className="text-xs">
                Network name
              </Label>
              <Input
                id="network-name"
                placeholder="e.g. survival"
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
                Cancel
              </Button>
              <Button variant="primary" size="sm" onPress={submit} isDisabled={!name.trim() || create.isPending}>
                Create
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}

function NetworkCard({ network, users, canManage }: { network: Network; users: ExtendedUser[]; canManage: boolean }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [permissions, setPermissions] = useState(NETWORK_PERMISSIONS.map((permission) => permission.key));
  const [confirming, setConfirming] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["networks"] });
  const add = useMutation({
    mutationFn: async () => {
      const user = users.find((candidate) => candidate.username === username.trim());
      if (!user) throw new Error(`User ${username.trim()} not found`);
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
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">{network.name}</span>
          <span className="rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] uppercase text-foreground/70">
            {count} member{count === 1 ? "" : "s"}
          </span>
        </div>
        {canManage && (
          <Button
            size="sm"
            variant="danger"
            onPress={() => (confirming ? remove.mutate() : setConfirming(true))}
            isDisabled={remove.isPending}
          >
            <Trash2 className="h-3.5 w-3.5" /> {confirming ? "Confirm delete" : "Delete"}
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
                    label={`${member.username} permissions in ${network.name}`}
                    value={member.permissions}
                    onChange={(granted) => update.mutate({ id: member.id, granted })}
                    isDisabled={update.isPending}
                  />
                ) : (
                  <span className="text-xs text-foreground/60">{permissionSummary(member.permissions)}</span>
                )}
                {canManage && (
                  <Button
                    isIconOnly
                    variant="ghost"
                    size="sm"
                    className="text-danger"
                    aria-label={`Remove ${member.username} from ${network.name}`}
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
        <p className="text-xs text-foreground/60">No members yet</p>
      )}
      {canManage && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input
              aria-label={`Add member to ${network.name}`}
              placeholder="Add member by username…"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && username.trim()) add.mutate();
              }}
              className="flex-1"
            />
            <Button size="sm" variant="outline" onPress={() => add.mutate()} isDisabled={!username.trim() || add.isPending}>
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
          <PermissionPicker
            label={`New member permissions in ${network.name}`}
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
            <span className="text-xs">{permission.label}</span>
          </Checkbox.Content>
        </Checkbox>
      ))}
    </div>
  );
}

function permissionSummary(granted: string[]) {
  return (
    NETWORK_PERMISSIONS.filter((permission) => granted.includes(permission.key))
      .map((permission) => permission.label)
      .join(", ") || "View only"
  );
}

function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-xs text-danger">
      {errorText(error, "Request failed")}
    </p>
  );
}
