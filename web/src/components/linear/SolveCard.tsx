import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, ListBox, ListBoxItem, Select } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { Sparkles } from "lucide-react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useAssistantStatus } from "@/lib/assistant";
import { useOptionalIntl } from "@/lib/i18n/format";
import { Linear, LINEAR_KEY } from "@/lib/linear";
import { Repositories, REPOSITORIES_KEY } from "@/lib/repositories";
import type { LinearIssueDetail, LinearRun, Repository } from "@/types";

const MESSAGES: Record<string, MessageDescriptor> = defineMessages({
  title: { id: "web.linear.solve_title", defaultMessage: "Solve with Assistant", description: "Linear: title of the card that starts an Assistant conversation for an issue" },
  opensIn: { id: "web.linear.solve_opens_in", defaultMessage: "Opens a conversation in {repository}'s Assistant tab", description: "Linear: text at the top right of the solve card naming the repository whose Assistant tab opens" },
  opensNone: { id: "web.linear.solve_opens_none", defaultMessage: "Opens a conversation in the Assistant tab", description: "Linear: text at the top right of the solve card when no repository is chosen yet" },
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
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-sm">
        <p className="text-muted">{intl.formatMessage(MESSAGES.disabledNote)}</p>
        <Link to="/settings/integrations" className="text-accent hover:underline">{intl.formatMessage(MESSAGES.integrations)}</Link>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">{intl.formatMessage(MESSAGES.title)}</h3>
        <span className="text-xs text-muted">{intl.formatMessage(repo ? MESSAGES.opensIn : MESSAGES.opensNone, { repository: repo?.name ?? "" })}</span>
      </header>
      <div className="grid gap-3 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-start">
        <span className="pt-2 text-sm text-muted">{intl.formatMessage(MESSAGES.repository)}</span>
        <div className="flex flex-col gap-1.5">
          <Select aria-label={intl.formatMessage(MESSAGES.repository)} value={selected} onChange={(next) => setPicked(String(next ?? ""))} placeholder={intl.formatMessage(MESSAGES.choose)} className="w-full">
            <Select.Trigger className="w-full items-center rounded border border-border bg-surface px-3 py-2 text-sm">
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
          <p className="text-xs text-muted">{intl.formatMessage(linked ? MESSAGES.linkedHint : MESSAGES.pickHint, { project: issue.project ?? "" })}</p>
        </div>
        <span className="pt-2 text-sm text-muted">{intl.formatMessage(MESSAGES.message)}</span>
        <textarea aria-label={intl.formatMessage(MESSAGES.message)} value={message} onChange={(event) => setMessage(event.target.value)} rows={3} className="w-full rounded border border-border bg-surface px-3 py-2 text-sm" />
      </div>
      {solve.error && <ErrorBanner err={solve.error} />}
      <footer className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted">{intl.formatMessage(MESSAGES.note, { id: issue.id })}</p>
        <Button variant="primary" className="shrink-0" onPress={() => repo && solve.mutate(repo)} isDisabled={!repo || !message.trim() || solve.isPending}>
          <Sparkles className="h-4 w-4" />
          {intl.formatMessage(MESSAGES.start)}
        </Button>
      </footer>
    </section>
  );
}
