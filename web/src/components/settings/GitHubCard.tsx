import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Input, Label, TextField } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { FolderGit2 } from "lucide-react";
import { errorTextIntl } from "@/lib/errors";
import { useOptionalIntl } from "@/lib/i18n/format";
import { GitHub, useGitHub } from "@/lib/repositories";
import { cn } from "@/lib/utils";

const TOKEN_PLACEHOLDER = "github_pat_…";

const M: Record<string, MessageDescriptor> = defineMessages({
  title: { id: "web.repositories.github.title", defaultMessage: "GitHub", description: "Integrations settings: title of the GitHub card; a product name, usually left untranslated" },
  subtitle: { id: "web.repositories.github.subtitle", defaultMessage: "Connect your GitHub account. Repository clone, pull, push and commit run as you, with your own token. Nobody else can use it.", description: "Integrations settings: subtitle of the GitHub card" },
  connected: { id: "web.repositories.github.connected", defaultMessage: "Connected", description: "Integrations settings: badge on the GitHub card once the user's token is stored" },
  token: { id: "web.repositories.github.token", defaultMessage: "Personal access token", description: "Integrations settings: label of the user's GitHub token row" },
  token_hint: { id: "web.repositories.github.token_hint", defaultMessage: "Create a fine-grained token in GitHub under Settings → Developer settings.", description: "Integrations settings: hint under the GitHub token row" },
  token_masked: { id: "web.repositories.github.token_masked", defaultMessage: "github_pat_••••••••{hint}", description: "Integrations settings: the stored GitHub token, masked except its last four characters" },
  replace: { id: "web.repositories.github.replace", defaultMessage: "Replace", description: "Integrations settings: button that replaces the stored GitHub token" },
  add: { id: "web.repositories.github.add", defaultMessage: "Add token", description: "Integrations settings: button that opens the form to add a GitHub token" },
  remove: { id: "web.repositories.github.remove", defaultMessage: "Remove", description: "Integrations settings: button that deletes the stored GitHub token" },
  field: { id: "web.repositories.github.field", defaultMessage: "GitHub token", description: "Integrations settings: label of the field where the user pastes a GitHub token" },
  cancel: { id: "web.routes.integrations.cancel", defaultMessage: "Cancel", description: "Integrations settings: button that closes the Linear API key form" },
  save: { id: "web.repositories.github.save", defaultMessage: "Save token", description: "Integrations settings: button that verifies and stores the GitHub token" },
  signed_in: { id: "web.repositories.github.signed_in", defaultMessage: "Signed in as @{login}", description: "Integrations settings: row naming the GitHub account of the token; {login} is the GitHub login" },
  signed_in_hint: { id: "web.repositories.github.signed_in_hint", defaultMessage: "Commits use your GitHub name and noreply email.", description: "Integrations settings: hint under the signed-in row" },
  verified: { id: "web.repositories.github.verified", defaultMessage: "Verified", description: "Integrations settings: status of the signed-in row once GitHub accepted the token" },
  contents: { id: "web.repositories.github.contents", defaultMessage: "Repository contents", description: "Integrations settings: GitHub token permission row for repository contents" },
  contents_hint: { id: "web.repositories.github.contents_hint", defaultMessage: "Needed to clone private repositories and to push.", description: "Integrations settings: hint under the repository contents row" },
  workflows: { id: "web.repositories.github.workflows", defaultMessage: "Workflows", description: "Integrations settings: GitHub token permission row for workflow files" },
  workflows_hint: { id: "web.repositories.github.workflows_hint", defaultMessage: "Needed only to push changes under .github/workflows.", description: "Integrations settings: hint under the workflows row" },
  read_write: { id: "web.repositories.github.read_write", defaultMessage: "Read & write", description: "Integrations settings: status of a GitHub permission with write access" },
  read_only: { id: "web.repositories.github.read_only", defaultMessage: "Read only", description: "Integrations settings: status of a GitHub permission with read access only" },
  granted: { id: "web.repositories.github.granted", defaultMessage: "Granted", description: "Integrations settings: status of a GitHub permission that is granted" },
  not_granted: { id: "web.repositories.github.not_granted", defaultMessage: "Not granted", description: "Integrations settings: status of a GitHub permission that is not granted" },
  not_reported: { id: "web.repositories.github.not_reported", defaultMessage: "Not reported", description: "Integrations settings: status of a GitHub permission that a fine-grained token does not report" },
});

export function GitHubCard() {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const github = useGitHub();
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const done = () => {
    setToken("");
    setEditing(false);
    void qc.invalidateQueries({ queryKey: ["integrations", "github"] });
  };
  const save = useMutation({ mutationFn: () => GitHub.putToken(token.trim()), onSuccess: done });
  const remove = useMutation({ mutationFn: GitHub.deleteToken, onSuccess: done });
  const error = save.error ?? remove.error;
  const data = github.data;
  const contents = data?.contents === "write" ? M.read_write : data?.contents === "read" ? M.read_only : data?.contents === "none" ? M.not_granted : M.not_reported;
  const workflows = data?.workflows === true ? M.granted : data?.workflows === false ? M.not_granted : M.not_reported;
  const rows = data?.keySet ? [
    { label: intl.formatMessage(M.signed_in, { login: data.login }), hint: intl.formatMessage(M.signed_in_hint), status: M.verified, good: true },
    { label: intl.formatMessage(M.contents), hint: intl.formatMessage(M.contents_hint), status: contents, good: data.contents === "write" },
    { label: intl.formatMessage(M.workflows), hint: intl.formatMessage(M.workflows_hint), status: workflows, good: data.workflows === true },
  ] : [];

  return (
    <Card>
      <Card.Content className="divide-y divide-border">
        <div className="flex flex-wrap items-center gap-3 pb-3.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-foreground text-background"><FolderGit2 className="h-5 w-5" /></span>
          <div className="min-w-48 flex-1">
            <div className="text-sm font-semibold">{intl.formatMessage(M.title)}</div>
            <div className="text-xs text-muted">{intl.formatMessage(M.subtitle)}</div>
          </div>
          {data?.keySet && (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-1 text-xs text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />{intl.formatMessage(M.connected)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 py-3.5">
          <div className="min-w-48 flex-1">
            <div className="text-sm font-medium">{intl.formatMessage(M.token)}</div>
            <div className="text-xs text-muted">{intl.formatMessage(M.token_hint)}</div>
          </div>
          {!editing && data?.keySet && <span className="font-mono text-xs text-muted">{intl.formatMessage(M.token_masked, { hint: data.keyHint })}</span>}
          {!editing && <Button variant="secondary" size="sm" onPress={() => setEditing(true)}>{intl.formatMessage(data?.keySet ? M.replace : M.add)}</Button>}
          {!editing && data?.keySet && <Button variant="danger" size="sm" isPending={remove.isPending} onPress={() => remove.mutate()}>{intl.formatMessage(M.remove)}</Button>}
          {editing && (
            <div className="w-full space-y-3">
              <TextField className="space-y-1.5">
                <Label className="text-xs">{intl.formatMessage(M.field)}</Label>
                <Input type="password" autoFocus value={token} placeholder={TOKEN_PLACEHOLDER} onChange={(event) => setToken(event.target.value)} spellCheck={false} />
              </TextField>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onPress={() => setEditing(false)}>{intl.formatMessage(M.cancel)}</Button>
                <Button isDisabled={token.trim() === ""} isPending={save.isPending} onPress={() => save.mutate()}>{intl.formatMessage(M.save)}</Button>
              </div>
            </div>
          )}
          {error && <div className="w-full text-xs text-danger">{errorTextIntl(intl, error)}</div>}
        </div>
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-4 py-3.5 last:pb-0">
            <div className="min-w-0">
              <div className="text-sm font-medium">{row.label}</div>
              <div className="text-xs text-muted">{row.hint}</div>
            </div>
            <span className={cn("shrink-0 text-xs font-medium", row.good ? "text-success" : "text-muted")}>{intl.formatMessage(row.status)}</span>
          </div>
        ))}
      </Card.Content>
    </Card>
  );
}
