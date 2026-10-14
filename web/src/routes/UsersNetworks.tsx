import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Chip, Input } from "@heroui/react";
import { Plus, Trash2, X } from "lucide-react";
import { useMe, can } from "@/lib/auth";
import { Networks, Users } from "@/lib/endpoints";
import { errorText } from "@/lib/errors";
import type { ExtendedUser, Network } from "@/types";

export function NetworksTab() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const canManage = can(me, "users:manage");
  const [name, setName] = useState("");
  const { data: networks = [], error } = useQuery({ queryKey: ["networks"], queryFn: () => Networks.list() });
  const { data: users = [] } = useQuery({ queryKey: ["users"], queryFn: () => Users.list() });
  const create = useMutation({
    mutationFn: () => Networks.create(name.trim()),
    onSuccess: () => {
      setName("");
      return qc.invalidateQueries({ queryKey: ["networks"] });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="max-w-2xl text-xs text-foreground/60">
          Members of a network get collaborator access to every server assigned to it: console, files, mods, start and
          stop. Delete, transfer and wipe stay with the owner.
        </p>
        {canManage && (
          <div className="flex items-center gap-2">
            <Input
              aria-label="Network name"
              placeholder="Network name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) create.mutate();
              }}
              className="w-56"
            />
            <Button variant="primary" onPress={() => create.mutate()} isDisabled={!name.trim() || create.isPending}>
              <Plus className="h-4 w-4" /> New network
            </Button>
          </div>
        )}
      </div>
      <ErrorText error={error ?? create.error} />
      {networks.length === 0 ? (
        <p className="text-sm text-foreground/60">No networks yet.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {networks.map((network) => (
            <NetworkCard key={network.name} network={network} users={users} canManage={canManage} />
          ))}
        </div>
      )}
    </div>
  );
}

function NetworkCard({ network, users, canManage }: { network: Network; users: ExtendedUser[]; canManage: boolean }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [confirming, setConfirming] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["networks"] });
  const add = useMutation({
    mutationFn: async () => {
      const user = users.find((candidate) => candidate.username === username.trim());
      if (!user) throw new Error(`User ${username.trim()} not found`);
      return Networks.addMember(network.name, user.id);
    },
    onSuccess: () => {
      setUsername("");
      return refresh();
    },
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
        <div className="flex flex-wrap gap-2">
          {network.members.map((member) => (
            <Chip key={member.id} variant="soft" color="default" className="flex items-center gap-1">
              <span className="font-mono text-xs">{member.username}</span>
              {canManage && (
                <Button
                  isIconOnly
                  variant="ghost"
                  size="sm"
                  className="ml-0.5 text-danger"
                  aria-label={`Remove ${member.username} from ${network.name}`}
                  onPress={() => removeMember.mutate(member.id)}
                  isDisabled={removeMember.isPending}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </Chip>
          ))}
        </div>
      ) : (
        <p className="text-xs text-foreground/60">No members yet</p>
      )}
      {canManage && (
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
      )}
      <ErrorText error={add.error ?? removeMember.error ?? remove.error} />
    </Card>
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
