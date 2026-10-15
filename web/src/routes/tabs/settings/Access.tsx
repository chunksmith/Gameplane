import { useResourceClient, useResourceTarget, resourceKey, useResourceAccess } from "@/lib/resourceTarget";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { GameServer } from "@/types";
import { Button, Input, Label, Chip, Card, CardContent, Select, ListBox, ListBoxItem } from "@heroui/react";
import { useMe, can } from "@/lib/auth";
import { Networks } from "@/lib/endpoints";

import { errorText } from "@/lib/errors";
import { NETWORK_ANNOTATION, OWNER_ANNOTATION } from "@/lib/annotations";

const COLLABORATORS_ANNOTATION = "gameplane.local/collaborators";
const COLLABORATOR_NAMES_ANNOTATION = "gameplane.local/collaborator-names";

interface Props {
  gs?: GameServer;
}

export function AccessSection({ gs }: Props) {
  const resourceTarget = useResourceTarget({ name: gs?.metadata.name ?? "", namespace: gs?.metadata.namespace });
  const resourceClient = useResourceClient(resourceTarget);
  const { Servers } = resourceClient;
  const qc = useQueryClient();
  const access = useResourceAccess();
  const [addInput, setAddInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [networkInput, setNetworkInput] = useState("");

  const setCollab = useMutation({
    mutationFn: async (body: { userIds?: number[]; usernames?: string[] }) => {
      if (!gs) return;
      const namespace = gs.metadata.namespace ?? "gameplane-games";
      return Servers.setCollaborators(gs.metadata.name, namespace, body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["fleet"] });
      setAddInput("");
      setError(null);
      return qc.invalidateQueries({ queryKey: resourceKey(resourceTarget, "server", gs?.metadata.name) });
    },
    onError: (err) => {
      setError(errMsg(err));
    },
  });

  const setNetwork = useMutation({
    mutationFn: async (network: string) => {
      if (!gs) return;
      return Servers.setNetwork(gs.metadata.name, gs.metadata.namespace ?? "gameplane-games", network);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["fleet"] });
      setNetworkInput("");
      setError(null);
      return qc.invalidateQueries({ queryKey: resourceKey(resourceTarget, "server", gs?.metadata.name) });
    },
    onError: (err) => {
      setError(errMsg(err));
    },
  });

  const { data: me } = useMe();
  const { data: networks } = useQuery({
    queryKey: ["networks"],
    queryFn: () => Networks.list(),
    enabled: access?.canDelete === true && can(me, "users:read"),
  });

  if (!gs) {
    return <div className="p-6 text-sm text-default-500">Loading…</div>;
  }

  const ann = gs.metadata.annotations ?? {};
  const ownerName = ann[OWNER_ANNOTATION] ?? "—";
  const network = ann[NETWORK_ANNOTATION] ?? "";
  const collaboratorIDs = ann[COLLABORATORS_ANNOTATION]
    ? ann[COLLABORATORS_ANNOTATION].split(",").map((s) => s.trim())
    : [];
  const collaboratorNames = ann[COLLABORATOR_NAMES_ANNOTATION]
    ? ann[COLLABORATOR_NAMES_ANNOTATION].split(",").map((s) => s.trim())
    : [];

  // Collaborator management is restricted to the owner or target administrator.
  const canManage = access?.canDelete === true;

  // Misalignment guard: if the parsed collaborators and collaborator-names
  // have different lengths, the annotations were modified outside the dashboard.
  const isAligned = collaboratorIDs.length === collaboratorNames.length;
  const canEditCollaborators = canManage && isAligned;

  const handleAddCollaborator = () => {
    const name = addInput.trim();
    if (!name) return;

    // Keep existing IDs; send only the new username.
    // The server unions and dedupes.
    const newUserIds = collaboratorIDs.map((id) => Number(id));

    setCollab.mutate({
      userIds: newUserIds,
      usernames: [name],
    });
  };

  const handleRemoveCollaborator = (index: number) => {
    // Remove the collaborator at the given index
    const newUserIds = collaboratorIDs
      .filter((_, i) => i !== index)
      .map((id) => Number(id));

    setCollab.mutate({
      userIds: newUserIds,
    });
  };

  return (
    <div className="space-y-3">
      <Card className="border border-divider bg-default/40">
        <CardContent className="gap-0 px-4 py-4">
          <Label className="text-sm font-medium">Owner</Label>
          <div className="pt-1 font-mono text-sm text-default-500">{ownerName}</div>
        </CardContent>
      </Card>

      <Card className="border border-divider bg-default/40">
        <CardContent className="gap-0 px-4 py-4">
          <div className="space-y-3">
            <div>
              <Label className="text-sm font-medium">Collaborators</Label>
              <p className="pt-1 text-xs text-default-500">
                Collaborators get full control of this server (console, files, settings). They
                can&apos;t transfer ownership or edit this list.
              </p>
            </div>

            <div className="space-y-2">
              {!isAligned && (
                <div className="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning-600 dark:text-warning-400">
                  Collaborators were modified outside the dashboard.
                </div>
              )}
              {collaboratorNames.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {collaboratorNames.map((name, idx) => (
                    <Chip
                      key={idx}
                      variant="soft"
                      color="default"
                      className="flex items-center gap-1"
                    >
                      <span>{name}</span>
                      {canEditCollaborators && (
                        <Button
                          isIconOnly
                          variant="ghost"
                          size="sm"
                          className="ml-0.5 text-danger"
                          onPress={() => handleRemoveCollaborator(idx)}
                          isDisabled={setCollab.isPending}
                          aria-label={`Remove ${name}`}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      )}
                    </Chip>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-default-500">None yet</div>
              )}
            </div>

            {canEditCollaborators && (
              <div className="flex items-center gap-2 pt-1">
                <Input
                  value={addInput}
                  onChange={(e) => setAddInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleAddCollaborator();
                    }
                  }}
                  placeholder="Add collaborator by username…"
                  className="flex-1"
                  disabled={setCollab.isPending}
                  type="text"
                />
                <Button
                  size="sm"
                  variant="primary"
                  onPress={() => handleAddCollaborator()}
                  isDisabled={!addInput.trim() || setCollab.isPending}
                >
                  Add
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="border border-divider bg-default/40">
        <CardContent className="gap-0 px-4 py-4">
          <div className="space-y-3">
            <div>
              <Label className="text-sm font-medium">Network</Label>
              <p className="pt-1 text-xs text-default-500">
                Members of this network can view this server; console and manage access follow each member&apos;s network permissions. Only the owner or an admin can change it.
              </p>
            </div>
            {network ? (
              <Chip variant="soft" color="default" className="flex w-fit items-center gap-1">
                <span>{network}</span>
                {canManage && (
                  <Button
                    isIconOnly
                    variant="ghost"
                    size="sm"
                    className="ml-0.5 text-danger"
                    onPress={() => setNetwork.mutate("")}
                    isDisabled={setNetwork.isPending}
                    aria-label="Remove from network"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </Chip>
            ) : (
              <div className="text-xs text-default-500">Not in a network</div>
            )}
            {canManage && (
              <div className="flex items-center gap-2 pt-1">
                {networks ? (
                  <Select
                    aria-label="Network name"
                    placeholder="Assign to network…"
                    value={networkInput}
                    onChange={(value) => setNetworkInput(String(value))}
                    isDisabled={setNetwork.isPending}
                    className="flex-1"
                  >
                    <Select.Trigger className="w-full items-center rounded border border-border bg-surface px-3 py-2 text-sm hover:bg-surface/80">
                      <Select.Value className="text-[var(--field-placeholder)]" />
                      <Select.Indicator className="ml-auto h-4 w-4" />
                    </Select.Trigger>
                    <Select.Popover className="rounded border border-border">
                      <ListBox className="p-0" aria-label="Networks">
                        {networks
                          .filter((option) => option.name !== network)
                          .map((option) => (
                            <ListBoxItem key={option.name} id={option.name}>
                              {option.name}
                            </ListBoxItem>
                          ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                ) : (
                  <Input
                    value={networkInput}
                    onChange={(e) => setNetworkInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && networkInput.trim()) setNetwork.mutate(networkInput.trim());
                    }}
                    placeholder="Assign to network…"
                    aria-label="Network name"
                    className="flex-1"
                    disabled={setNetwork.isPending}
                    type="text"
                  />
                )}
                <Button
                  size="sm"
                  variant="primary"
                  onPress={() => setNetwork.mutate(networkInput.trim())}
                  isDisabled={!networkInput.trim() || setNetwork.isPending}
                >
                  Assign
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
    </div>
  );
}

function errMsg(err: unknown): string {
  return errorText(err, "failed");
}
