import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContainer,
  ModalDialog,
  ModalFooter,
  ModalHeader,
  ModalHeading,
} from "@heroui/react";
import { createResourceClient } from "@/lib/endpoints";
import { DEFAULT_GROUP, serverGroups, withGroups } from "@/lib/backupGroups";
import { targetLabel, type Located } from "@/lib/fleet";
import { GroupPicker } from "./GroupPicker";
import { ErrorBanner } from "./ErrorBanner";
import type { GameServer } from "@/types";

export function ServerGroupsDialog({ server, knownGroups, onClose }: { server: Located<GameServer>; knownGroups: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [groups, setGroups] = useState(serverGroups(server.metadata.labels));
  const save = useMutation({
    mutationFn: async () => {
      const { Servers } = createResourceClient(server.fleetTarget);
      const ns = server.fleetTarget.namespace;
      const current = await Servers.get(server.metadata.name, ns);
      return Servers.update(server.metadata.name, { ...current, metadata: { ...current.metadata, labels: withGroups(current.metadata.labels, groups) } }, ns);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["fleet", "servers"] });
      onClose();
    },
  });
  return (
    <Modal isOpen onOpenChange={(open) => { if (!open) onClose(); }}>
      <ModalBackdrop isDismissable={!save.isPending}>
        <ModalContainer>
          <ModalDialog>
            <ModalHeader>
              <ModalHeading>Backup groups · {server.metadata.name}</ModalHeading>
            </ModalHeader>
            <ModalBody className="gap-4">
              <p className="text-sm text-muted">
                {targetLabel(server.fleetTarget)}. Every group schedule that targets one of these groups backs this server up.
                With no group selected the server belongs to <span className="font-mono text-xs">{DEFAULT_GROUP}</span>.
              </p>
              <GroupPicker known={knownGroups} value={groups} onChange={setGroups} />
              {save.error && <ErrorBanner err={save.error} />}
            </ModalBody>
            <ModalFooter>
              <Button variant="ghost" onPress={onClose} isDisabled={save.isPending}>Cancel</Button>
              <Button onPress={() => save.mutate()} isDisabled={save.isPending}>{save.isPending ? "Saving…" : "Save groups"}</Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}
