import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { FileCode2, Loader2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useOptionalIntl } from "@/lib/i18n/format";
import { Git, gitErrorText } from "@/lib/repositories";
import type { ResourceTarget } from "@/lib/resourceTarget";
import { GitTab } from "../repository/GitTab";

const M: Record<string, MessageDescriptor> = defineMessages({
  title: { id: "web.servers.git.enable_title", defaultMessage: "This server's files are a Git repository", description: "Server Git tab: title of the panel shown when the server's data folder has a .git folder but Git is not enabled for the server yet" },
  body: { id: "web.servers.git.enable_body", defaultMessage: "Enable Git to commit, pull and push from here. The server restarts once to load the Git-capable agent.", description: "Server Git tab: text of the panel that offers to enable Git for the server" },
  enable: { id: "web.servers.git.enable", defaultMessage: "Enable Git", description: "Server Git tab: button and confirm action that enable Git for the server; keep it short" },
  confirm_title: { id: "web.servers.git.enable_confirm_title", defaultMessage: "Enable Git for {name}?", description: "Server Git tab: title of the confirm dialog before enabling Git; {name} is the server name" },
  confirm_body: { id: "web.servers.git.enable_confirm_body", defaultMessage: "The server restarts to load the Git-capable agent. Players on it are disconnected.", description: "Server Git tab: body of the confirm dialog before enabling Git" },
  starting: { id: "web.servers.git.starting", defaultMessage: "Waiting for the Git-capable agent to start…", description: "Server Git tab: text while the server restarts after Git was enabled" },
  owner_only: { id: "web.servers.git.owner_only", defaultMessage: "Only the server's owner or an admin can enable Git.", description: "Server Git tab: note shown instead of the enable button to users who cannot enable Git" },
});

export function ServerGitTab({ target, unavailable, failure, enabling, canWrite, canPush, canEnable }: {
  target: ResourceTarget;
  unavailable: boolean;
  failure?: unknown;
  enabling: boolean;
  canWrite: boolean;
  canPush: boolean;
  canEnable: boolean;
}) {
  const intl = useOptionalIntl();
  const [confirm, setConfirm] = useState(false);
  const enable = useMutation({ mutationFn: () => Git.enableServer(target) });
  if (!unavailable) return <GitTab target={target} canWrite={canWrite} canPush={canPush} sync />;
  if (failure) {
    return (
      <div className="mx-auto max-w-lg p-10">
        <ErrorBanner err={gitErrorText(intl, failure)} />
      </div>
    );
  }
  if (enabling || enable.isSuccess) {
    return (
      <div className="mx-auto max-w-md space-y-3 p-10 text-center">
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-accent" />
        <p className="text-sm">{intl.formatMessage(M.starting)}</p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-lg space-y-3 p-10 text-center">
      <FileCode2 className="mx-auto h-6 w-6 text-muted" />
      <p className="text-sm font-medium">{intl.formatMessage(M.title)}</p>
      <p className="text-xs text-muted">{intl.formatMessage(M.body)}</p>
      {enable.error && <ErrorBanner err={gitErrorText(intl, enable.error)} onDismiss={() => enable.reset()} />}
      {canEnable
        ? <Button variant="primary" isDisabled={enable.isPending} onPress={() => setConfirm(true)}>{intl.formatMessage(M.enable)}</Button>
        : <p className="text-xs text-muted">{intl.formatMessage(M.owner_only)}</p>}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={intl.formatMessage(M.confirm_title, { name: target.name })}
        description={intl.formatMessage(M.confirm_body)}
        confirmLabel={intl.formatMessage(M.enable)}
        busy={enable.isPending}
        onConfirm={() => {
          enable.mutate();
          setConfirm(false);
        }}
      />
    </div>
  );
}
