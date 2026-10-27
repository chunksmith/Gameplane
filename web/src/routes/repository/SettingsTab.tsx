import { useId, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Card, Input } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { Check, Plus } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Networks } from "@/lib/endpoints";
import { useOptionalIntl } from "@/lib/i18n/format";
import { gitErrorText, initials, Repositories, repoSlug, useRepositoryRefresh, type RepositoryProps } from "@/lib/repositories";
import { resourceKey } from "@/lib/resourceTarget";
import { cn } from "@/lib/utils";
import type { RepositoryCollaborator } from "@/types";
import { RepositoryAvatar } from "../Repositories";

const M: Record<string, MessageDescriptor> = defineMessages({
  kind: { id: "web.repositories.settings.kind", defaultMessage: "repository", description: "Repository settings: small label under the repository name on the summary card" },
  owner: { id: "web.repositories.settings.owner", defaultMessage: "Owner", description: "Repository settings: summary card row label for the owner" },
  disk: { id: "web.repositories.settings.disk", defaultMessage: "Disk", description: "Repository settings: summary card row label for the volume size" },
  collaborators_count: { id: "web.repositories.settings.collaborators_count", defaultMessage: "Collaborators", description: "Repository settings: summary card row label for the number of collaborators" },
  source: { id: "web.repositories.settings.source", defaultMessage: "Source", description: "Repository settings: summary card row label for owner/repo on GitHub" },
  network_title: { id: "web.repositories.settings.network_title", defaultMessage: "Network · {network}", description: "Repository settings: title of the network card; {network} is the network name" },
  network_none: { id: "web.repositories.settings.network_none", defaultMessage: "No network", description: "Repository settings: title of the network card when the repository has no network" },
  network_hint: { id: "web.repositories.settings.network_hint", defaultMessage: "Members of the network can open, edit and push this repository with their own token, as their network permissions allow.", description: "Repository settings: text under the network card title" },
  change_network: { id: "web.repositories.settings.change_network", defaultMessage: "Change network", description: "Repository settings: button that edits the network; keep it short" },
  network_field: { id: "web.repositories.settings.network_field", defaultMessage: "Network name, empty for none", description: "Repository settings: accessible name and placeholder of the network name field" },
  save: { id: "web.repositories.settings.save", defaultMessage: "Save", description: "Repository settings: button that saves the network; keep it short" },
  cancel: { id: "web.repositories.cancel", defaultMessage: "Cancel", description: "Repositories: button that closes a dialog without changes" },
  collaborators: { id: "web.repositories.settings.collaborators", defaultMessage: "Collaborators", description: "Repository settings: title of the collaborators card" },
  collaborators_hint: { id: "web.repositories.settings.collaborators_hint", defaultMessage: "People outside the network who can work on this repository.", description: "Repository settings: text under the collaborators card title" },
  add_collaborator: { id: "web.repositories.settings.add_collaborator", defaultMessage: "Add collaborator", description: "Repository settings: button that adds the chosen user as a collaborator; keep it short" },
  collaborator_field: { id: "web.repositories.settings.collaborator_field", defaultMessage: "Username", description: "Repository settings: accessible name and placeholder of the field for the user to add" },
  no_collaborators: { id: "web.repositories.settings.no_collaborators", defaultMessage: "No collaborators yet.", description: "Repository settings: empty collaborators list text" },
  collaborator_badge: { id: "web.repositories.settings.collaborator_badge", defaultMessage: "collaborator", description: "Repository settings: badge on a collaborator row; keep it short" },
  grant_read: { id: "web.repositories.settings.grant_read", defaultMessage: "Read", description: "Repository settings: collaborator permission chip for reading, always on; keep it short" },
  grant_edit: { id: "web.repositories.settings.grant_edit", defaultMessage: "Edit", description: "Repository settings: collaborator permission chip for editing files and committing; keep it short" },
  grant_push: { id: "web.repositories.settings.grant_push", defaultMessage: "Push", description: "Repository settings: collaborator permission chip for pushing; keep it short" },
  grants_label: { id: "web.repositories.settings.grants_label", defaultMessage: "{username} permissions", description: "Repository settings: accessible name of a collaborator's permission chips; {username} is the user" },
  remove: { id: "web.repositories.settings.remove", defaultMessage: "Remove", description: "Repository settings: button that removes a collaborator; keep it short" },
  danger_title: { id: "web.repositories.settings.danger_title", defaultMessage: "Remove this repository", description: "Repository settings: title of the danger card" },
  danger_hint: { id: "web.repositories.settings.danger_hint", defaultMessage: "Deletes the panel's working copy and uncommitted changes. GitHub is not touched.", description: "Repository settings: text under the danger card title" },
  danger_button: { id: "web.repositories.settings.danger_button", defaultMessage: "Remove repository", description: "Repository settings: button that removes the repository, and the confirm button; keep it short" },
  danger_confirm: { id: "web.repositories.settings.danger_confirm", defaultMessage: "Remove {name}?", description: "Repository settings: title of the remove confirm dialog; {name} is the repository name" },
});

export function RepositorySettingsTab({ repository, target, permissions }: RepositoryProps) {
  const intl = useOptionalIntl();
  const navigate = useNavigate();
  const refresh = useRepositoryRefresh(target);
  const { name, namespace } = repository;
  const canManage = permissions.includes("repositories:manage");
  const [editingNetwork, setEditingNetwork] = useState(false);
  const [network, setNetwork] = useState(repository.network);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const networksId = useId();
  const networks = useQuery({ queryKey: ["networks"], queryFn: Networks.list, enabled: editingNetwork, retry: false });
  const collaborators = useQuery({ queryKey: resourceKey(target, "collaborators"), queryFn: ({ signal }) => Repositories.collaborators(name, namespace, signal) });
  const saveNetwork = useMutation({
    mutationFn: () => Repositories.setNetwork(name, network.trim(), namespace),
    onSuccess: async () => { setEditingNetwork(false); await refresh(); },
  });
  const remove = useMutation({
    mutationFn: () => Repositories.remove(name, namespace),
    onSuccess: async () => { await navigate({ to: "/repositories" }); await refresh(); },
  });
  const rows: Array<[MessageDescriptor, string]> = [
    [M.source, repoSlug(repository.url)],
    [M.owner, repository.owner.name],
    [M.disk, repository.storage.size],
    [M.collaborators_count, String(repository.collaborators)],
  ];

  return (
    <div className="grid gap-6 p-4 md:p-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card className="h-fit border border-border">
        <Card.Content className="items-center gap-3 p-6 text-center">
          <RepositoryAvatar name={name} large />
          <div className="text-base font-semibold">{name}</div>
          <div className="font-mono text-xs text-muted">{intl.formatMessage(M.kind)}</div>
          {repository.branch && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">{repository.branch}</span>}
          <dl className="mt-3 w-full space-y-2 border-t border-border pt-4 text-left text-sm">
            {rows.map(([label, value]) => (
              <div key={label.id} className="flex justify-between gap-3">
                <dt className="text-muted">{intl.formatMessage(label)}</dt>
                <dd className="truncate">{value}</dd>
              </div>
            ))}
          </dl>
        </Card.Content>
      </Card>

      <div className="space-y-6">
        <Card className="border border-border">
          <Card.Content className="gap-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold">{repository.network ? intl.formatMessage(M.network_title, { network: repository.network }) : intl.formatMessage(M.network_none)}</div>
                <p className="text-sm text-muted">{intl.formatMessage(M.network_hint)}</p>
              </div>
              {canManage && !editingNetwork && <Button variant="secondary" size="sm" onPress={() => setEditingNetwork(true)}>{intl.formatMessage(M.change_network)}</Button>}
            </div>
            {editingNetwork && (
              <div className="flex flex-wrap items-center gap-2">
                <Input aria-label={intl.formatMessage(M.network_field)} placeholder={intl.formatMessage(M.network_field)} value={network} onChange={(event) => setNetwork(event.target.value)} list={networksId} className="min-w-48 flex-1" />
                <datalist id={networksId}>
                  {(networks.data ?? []).map((item) => <option key={item.name} value={item.name} />)}
                </datalist>
                <Button variant="ghost" size="sm" onPress={() => { setNetwork(repository.network); setEditingNetwork(false); }}>{intl.formatMessage(M.cancel)}</Button>
                <Button variant="primary" size="sm" isPending={saveNetwork.isPending} onPress={() => saveNetwork.mutate()}>{intl.formatMessage(M.save)}</Button>
              </div>
            )}
            {saveNetwork.error && <ErrorBanner err={gitErrorText(intl, saveNetwork.error)} />}
          </Card.Content>
        </Card>

        <CollaboratorsCard repositoryName={name} namespace={namespace} canManage={canManage} collaborators={collaborators.data} error={collaborators.error} onChanged={refresh} />

        {canManage && (
          <Card className="border border-danger/40">
            <Card.Content className="flex-row flex-wrap items-center justify-between gap-3 p-5">
              <div>
                <div className="font-semibold">{intl.formatMessage(M.danger_title)}</div>
                <p className="text-sm text-muted">{intl.formatMessage(M.danger_hint)}</p>
              </div>
              <Button variant="danger" size="sm" onPress={() => setConfirmRemove(true)}>{intl.formatMessage(M.danger_button)}</Button>
            </Card.Content>
          </Card>
        )}
        {remove.error && <ErrorBanner err={gitErrorText(intl, remove.error)} />}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={intl.formatMessage(M.danger_confirm, { name })}
        description={intl.formatMessage(M.danger_hint)}
        confirmPhrase={name}
        confirmLabel={intl.formatMessage(M.danger_button)}
        destructive
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

function CollaboratorsCard({ repositoryName, namespace, canManage, collaborators, error, onChanged }: {
  repositoryName: string;
  namespace: string;
  canManage: boolean;
  collaborators?: RepositoryCollaborator[];
  error: unknown;
  onChanged: () => Promise<void>;
}) {
  const intl = useOptionalIntl();
  const [username, setUsername] = useState("");
  const change = useMutation({
    mutationFn: ({ userId, grants, remove }: { userId: number; grants?: { edit: boolean; push: boolean }; remove?: boolean }) =>
      remove ? Repositories.removeCollaborator(repositoryName, userId, namespace) : Repositories.setCollaborator(repositoryName, userId, grants ?? { edit: false, push: false }, namespace),
    onSuccess: onChanged,
  });
  const add = useMutation({
    mutationFn: () => Repositories.addCollaborator(repositoryName, username.trim(), { edit: true, push: false }, namespace),
    onSuccess: async () => { setUsername(""); await onChanged(); },
  });

  return (
    <Card className="border border-border">
      <Card.Content className="gap-4 p-5">
        <div>
          <div className="font-semibold">{intl.formatMessage(M.collaborators)}</div>
          <p className="text-sm text-muted">{intl.formatMessage(M.collaborators_hint)}</p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label={intl.formatMessage(M.collaborator_field)} placeholder={intl.formatMessage(M.collaborator_field)} value={username} onChange={(event) => setUsername(event.target.value)} className="min-w-48 flex-1" />
            <Button variant="secondary" size="sm" isDisabled={username.trim() === "" || add.isPending} onPress={() => add.mutate()}>
              <Plus className="h-4 w-4" />{intl.formatMessage(M.add_collaborator)}
            </Button>
          </div>
        )}
        {add.error && <ErrorBanner err={gitErrorText(intl, add.error)} onDismiss={() => add.reset()} />}
        {error ? <ErrorBanner err={gitErrorText(intl, error)} /> : null}
        {change.error && <ErrorBanner err={gitErrorText(intl, change.error)} onDismiss={() => change.reset()} />}
        {collaborators?.length === 0 && <p className="text-sm text-muted">{intl.formatMessage(M.no_collaborators)}</p>}
        {!!collaborators?.length && (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {collaborators.map((collaborator) => (
              <li key={collaborator.userId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/10 font-mono text-xs text-accent">{initials(collaborator.username)}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{collaborator.username}</span>
                <span className="rounded-md bg-accent/10 px-2 py-0.5 text-xs text-accent">{intl.formatMessage(M.collaborator_badge)}</span>
                <div role="group" aria-label={intl.formatMessage(M.grants_label, { username: collaborator.username })} className="flex gap-1.5">
                  <GrantChip label={intl.formatMessage(M.grant_read)} selected disabled />
                  <GrantChip label={intl.formatMessage(M.grant_edit)} selected={collaborator.edit} disabled={!canManage || change.isPending} onToggle={() => change.mutate({ userId: collaborator.userId, grants: { edit: !collaborator.edit, push: collaborator.push } })} />
                  <GrantChip label={intl.formatMessage(M.grant_push)} selected={collaborator.push} disabled={!canManage || change.isPending} onToggle={() => change.mutate({ userId: collaborator.userId, grants: { edit: collaborator.edit, push: !collaborator.push } })} />
                </div>
                {canManage && (
                  <Button variant="ghost" size="sm" isDisabled={change.isPending} onPress={() => change.mutate({ userId: collaborator.userId, remove: true })}>{intl.formatMessage(M.remove)}</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card.Content>
    </Card>
  );
}

function GrantChip({ label, selected, disabled, onToggle }: { label: string; selected: boolean; disabled?: boolean; onToggle?: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed",
        selected ? "bg-accent/10 text-accent" : "border border-border text-muted hover:text-foreground",
      )}
    >
      {selected ? <Check className="h-3 w-3" aria-hidden="true" /> : <Plus className="h-3 w-3" aria-hidden="true" />}
      {label}
    </button>
  );
}
