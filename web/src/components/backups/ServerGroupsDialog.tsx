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
import { useOptionalIntl } from "@/lib/i18n/format";

export function ServerGroupsDialog({ server, knownGroups, onClose }: { server: Located<GameServer>; knownGroups: string[]; onClose: () => void }) {
  const intl = useOptionalIntl();
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
              <ModalHeading>{intl.formatMessage({ id: "web.components.backups.server_groups_dialog.backup_groups_name", defaultMessage: "Backup groups · {name}", description: "Server groups dialog: heading of the dialog that picks a server's backup groups; {name} is the server name" }, { name: server.metadata.name })}</ModalHeading>
            </ModalHeader>
            <ModalBody className="gap-4">
              <p className="text-sm text-muted">
                {intl.formatMessage({ id: "web.components.backups.server_groups_dialog.target_group_sentence", defaultMessage: "{target}. Every group schedule that targets one of these groups backs this server up. With no group selected the server belongs to <b>{group}</b>.", description: "Server groups dialog: sentence under the heading explaining that group schedules back this server up; {target} is the cluster or namespace label of the server, {group} is the default group name, and <b> wraps it in monospace" }, { target: targetLabel(server.fleetTarget), group: DEFAULT_GROUP, b: (chunks) => <span className="font-mono text-xs">{chunks}</span> })}
              </p>
              <GroupPicker known={knownGroups} value={groups} onChange={setGroups} />
              {save.error && <ErrorBanner err={save.error} />}
            </ModalBody>
            <ModalFooter>
              <Button variant="ghost" onPress={onClose} isDisabled={save.isPending}>{intl.formatMessage({ id: "web.components.backups.server_groups_dialog.cancel", defaultMessage: "Cancel", description: "Server groups dialog: button that closes the dialog without saving; keep it short" })}</Button>
              <Button onPress={() => save.mutate()} isDisabled={save.isPending}>{save.isPending ? intl.formatMessage({ id: "web.components.backups.server_groups_dialog.saving", defaultMessage: "Saving…", description: "Server groups dialog: label of the save button while the groups are being saved; keep it short" }) : intl.formatMessage({ id: "web.components.backups.server_groups_dialog.save_groups", defaultMessage: "Save groups", description: "Server groups dialog: button that saves the selected backup groups of the server; keep it short" })}</Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}
