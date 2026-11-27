import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, ListBox, ListBoxItem, Select } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { GitBranch, Info, Link2, Sparkles } from "lucide-react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useAssistantStatus } from "@/lib/assistant";
import { useOptionalIntl } from "@/lib/i18n/format";
import { Linear, LINEAR_KEY } from "@/lib/linear";
import { Repositories, REPOSITORIES_KEY } from "@/lib/repositories";
import type { LinearIssueDetail, LinearRun, Repository } from "@/types";

const MESSAGES: Record<string, MessageDescriptor> = defineMessages({
  title: { id: "web.linear.solve_title", defaultMessage: "Solve with Assistant", description: "Linear: title of the card that starts an Assistant conversation for an issue" },
  opensIn: { id: "web.linear.solve_opens_in", defaultMessage: "Opens a conversation in {repository}'s Assistant tab", description: "Linear: subtitle under the solve card title naming the repository whose Assistant tab opens" },
  opensNone: { id: "web.linear.solve_opens_none", defaultMessage: "Opens a conversation in the Assistant tab", description: "Linear: subtitle under the solve card title when no repository is chosen yet" },
  repository: { id: "web.linear.solve_repository", defaultMessage: "Repository", description: "Linear: label of the repository select in the solve card" },
  choose: { id: "web.linear.solve_choose", defaultMessage: "Choose a repository", description: "Linear: placeholder of the repository select in the solve card" },
  repoOption: { id: "web.linear.solve_repo_option", defaultMessage: "{name} · {branch} · {changes, plural, =0 {clean} one {# change} other {# changes}}", description: "Linear: repository option in the solve card; {changes} is the number of uncommitted changes" },
  linkedHint: { id: "web.linear.solve_linked_hint", defaultMessage: "Linked from project {project} · change in Repository links", description: "Linear: hint under the repository select when the repository comes from the project link; {project} is the Linear project name" },
  pickHint: { id: "web.linear.solve_pick_hint", defaultMessage: "Pick the repository that holds the code", description: "Linear: hint under the repository select when no repository is linked to the project" },
  message: { id: "web.linear.solve_message", defaultMessage: "First message", description: "Linear: label of the first message textarea in the solve card" },
  prompt: { id: "web.linear.solve_prompt", defaultMessage: "Solve {id}.", description: "Linear: prefilled first message of the solve card; {id} is the issue identifier" },
  note: { id: "web.linear.solve_note", defaultMessage: "Moves {id} to In Progress. The Assistant asks before it builds, deploys, pushes, replies or changes the status.", description: "Linear: note under the solve card explaining what starting the solve changes and what the Assistant asks first; {id} is the issue identifier" },
  start: { id: "web.linear.solve_start", defaultMessage: "Start solving", description: "Linear: primary button in the solve card that starts the Assistant conversation" },
  disabledNote: { id: "web.linear.solve_disabled_note", defaultMessage: "Connect your Linear API key in Settings → Integrations to solve issues here.", description: "Linear: note in place of the solve card when Linear is not connected" },
  integrations: { id: "web.linear.open_integrations", defaultMessage: "Open Integrations", description: "Linear: link to the Integrations settings page where the Linear API key is stored" },
});

const keyOf = (namespace: string, name: string) => `${namespace}/${name}`;

export function SolveCard({ issue, onStarted }: { issue: LinearIssueDetail; onStarted: (run: LinearRun) => void }) {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const status = useAssistantStatus();
  const repositories = useQuery({ queryKey: REPOSITORIES_KEY, queryFn: () => Repositories.list() });
  const links = useQuery({ queryKey: [...LINEAR_KEY, "links"], queryFn: () => Linear.links() });
  const linked = links.data?.find((link) => link.projectId === issue.projectId);
  const [picked, setPicked] = useState<string>();
  const [message, setMessage] = useState(() => intl.formatMessage(MESSAGES.prompt, { id: issue.id }));
  const selected = picked ?? (linked ? keyOf(linked.namespace, linked.repository) : "");
  const repo = repositories.data?.find((item) => keyOf(item.namespace, item.name) === selected);
  const solve = useMutation({
    mutationFn: (target: Repository) => Linear.solve(issue.id, { repository: target.name, namespace: target.namespace, message }),
    onSuccess: ({ conversation }, target) => {
      void qc.invalidateQueries({ queryKey: LINEAR_KEY });
      void qc.invalidateQueries({ queryKey: ["ai"] });
      const now = new Date().toISOString();
      onStarted({ conversation: conversation.id, status: "running", repository: target.name, namespace: target.namespace, createdAt: now, updatedAt: now });
    },
  });

  if (status.data && status.data.linear !== true) {
    return (
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 text-sm">
        <p className="text-muted">{intl.formatMessage(MESSAGES.disabledNote)}</p>
        <Link to="/settings/integrations" className="text-accent hover:underline">{intl.formatMessage(MESSAGES.integrations)}</Link>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-accent/35 bg-card">
      <header className="flex items-center gap-3 bg-accent-soft px-5 py-4">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{intl.formatMessage(MESSAGES.title)}</h3>
          <p className="truncate text-xs text-accent-soft-foreground">{intl.formatMessage(repo ? MESSAGES.opensIn : MESSAGES.opensNone, { repository: repo?.name ?? "" })}</p>
        </div>
      </header>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">{intl.formatMessage(MESSAGES.repository)}</span>
          <Select aria-label={intl.formatMessage(MESSAGES.repository)} value={selected} onChange={(next) => setPicked(String(next ?? ""))} placeholder={intl.formatMessage(MESSAGES.choose)} className="w-full">
            <Select.Trigger className="w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm">
              <GitBranch className="h-4 w-4 shrink-0 text-muted" />
              <Select.Value />
              <Select.Indicator className="ml-auto h-4 w-4" />
            </Select.Trigger>
            <Select.Popover className="rounded border border-border">
              <ListBox className="p-0">
                {repositories.data?.map((item) => {
                  const label = intl.formatMessage(MESSAGES.repoOption, { name: item.name, branch: item.branch, changes: item.changes });
                  return <ListBoxItem key={keyOf(item.namespace, item.name)} id={keyOf(item.namespace, item.name)} textValue={label}>{label}</ListBoxItem>;
                })}
              </ListBox>
            </Select.Popover>
          </Select>
          <p className="flex items-center gap-1.5 text-xs text-muted">
            {linked && <Link2 className="h-3.5 w-3.5 shrink-0" />}
            {intl.formatMessage(linked ? MESSAGES.linkedHint : MESSAGES.pickHint, { project: issue.project ?? "" })}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">{intl.formatMessage(MESSAGES.message)}</span>
          <textarea aria-label={intl.formatMessage(MESSAGES.message)} value={message} onChange={(event) => setMessage(event.target.value)} rows={3} className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm" />
        </div>
        {solve.error && <ErrorBanner err={solve.error} />}
      </div>
      <footer className="flex flex-col gap-3 border-t border-border bg-surface px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-start gap-1.5 text-xs text-muted">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" />
          {intl.formatMessage(MESSAGES.note, { id: issue.id })}
        </p>
        <Button variant="primary" className="shrink-0 shadow-lg shadow-accent/30" onPress={() => repo && solve.mutate(repo)} isDisabled={!repo || !message.trim() || solve.isPending}>
          <Sparkles className="h-4 w-4" />
          {intl.formatMessage(MESSAGES.start)}
        </Button>
      </footer>
    </section>
  );
}
