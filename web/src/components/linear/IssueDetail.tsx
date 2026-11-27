import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { ExternalLink, Square } from "lucide-react";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { Markdown } from "@/components/assistant/Markdown";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Assistant } from "@/lib/assistant";
import { useOptionalIntl } from "@/lib/i18n/format";
import { Linear, LINEAR_KEY, workspaceOf } from "@/lib/linear";
import { formatRelative } from "@/lib/utils";
import type { LinearComment, LinearIssueDetail, LinearRun } from "@/types";
import { elapsed, useNow } from "./IssueList";
import { SolveCard } from "./SolveCard";

const MESSAGES: Record<string, MessageDescriptor> = defineMessages({
  title: { id: "web.linear.issue_title", defaultMessage: "{id} · {title}", description: "Linear: issue line in the list and detail header; {id} is the issue identifier such as CHK-142, {title} the issue title" },
  project: { id: "web.linear.detail_project", defaultMessage: "project {project}", description: "Linear: meta item in the issue detail header naming the project" },
  opened: { id: "web.linear.detail_opened", defaultMessage: "opened by {author} {age}", description: "Linear: meta item in the issue detail header naming the author and how long ago it was opened" },
  assigned: { id: "web.linear.detail_assigned", defaultMessage: "assigned to {assignee}", description: "Linear: meta item in the issue detail header naming the assignee" },
  openInLinear: { id: "web.linear.open_in_linear", defaultMessage: "Open in Linear", description: "Linear: button that opens the issue in Linear in a new tab" },
  loading: { id: "web.linear.detail_loading", defaultMessage: "Loading issue…", description: "Linear: text in the issue detail while the issue loads" },
  description: { id: "web.linear.detail_description", defaultMessage: "Description", description: "Linear: heading of the issue description panel" },
  noDescription: { id: "web.linear.detail_no_description", defaultMessage: "No description", description: "Linear: text in the description panel when the issue has no description" },
  comments: { id: "web.linear.detail_comments", defaultMessage: "Comments · {count}", description: "Linear: heading of the comments panel; {count} is the number of comments" },
  commentAuthor: { id: "web.linear.comment_author", defaultMessage: "@{author}", description: "Linear: author of an issue comment, shown with an @ prefix" },
  replyHint: { id: "web.linear.reply_hint", defaultMessage: "The Assistant's reply appears here after you approve it", description: "Linear: hint under the comments panel explaining that the Assistant's reply is posted after approval" },
  runHeader: { id: "web.linear.run_header", defaultMessage: "Assistant", description: "Linear: first word of the Assistant run header above the embedded chat" },
  runTime: { id: "web.linear.run_status_time", defaultMessage: "{status} {time}", description: "Linear: run status with the elapsed m:ss time while the Assistant is running; {status} is the status, {time} the elapsed time" },
  openAssistant: { id: "web.linear.open_in_assistant", defaultMessage: "Open in Assistant tab", description: "Linear: link in the run header that opens the conversation in the repository's Assistant tab" },
  stop: { id: "web.linear.run_stop", defaultMessage: "Stop", description: "Linear: button in the run header that stops the running Assistant conversation" },
  noComments: { id: "web.linear.no_comments", defaultMessage: "No comments yet", description: "Linear: text in the comments panel when the issue has no comments" },
});

const RUN_STATUS: Record<string, MessageDescriptor> = defineMessages({
  running: { id: "web.linear.detail_run_running", defaultMessage: "Running", description: "Linear: status of the Assistant run in the chat header while it works on the issue" },
  awaiting_approval: { id: "web.linear.detail_run_awaiting", defaultMessage: "Waiting for approval", description: "Linear: status of the Assistant run in the chat header while it waits for the user's approval" },
  idle: { id: "web.linear.detail_run_idle", defaultMessage: "Finished", description: "Linear: status of the Assistant run in the chat header after it finished" },
  error: { id: "web.linear.detail_run_error", defaultMessage: "Stopped", description: "Linear: status of the Assistant run in the chat header when it stopped with an error" },
});

const SEPARATOR = { id: "web.common.separator_dot", defaultMessage: "·", description: "Visual separator between two items" };

export function IssueDetail({ id }: { id: string }) {
  const intl = useOptionalIntl();
  const [started, setStarted] = useState<LinearRun>();
  const detail = useQuery({
    queryKey: [...LINEAR_KEY, "issue", id],
    queryFn: () => Linear.issue(id),
    refetchInterval: (query) => {
      const status = query.state.data?.run?.status;
      return status === "running" || status === "awaiting_approval" ? 5_000 : false;
    },
  });
  if (detail.error) return <ErrorBanner err={detail.error} />;
  if (!detail.data) return <p className="p-4 text-sm text-muted">{intl.formatMessage(MESSAGES.loading)}</p>;
  const { issue, comments } = detail.data;
  const run = detail.data.run ?? started;
  const separator = intl.formatMessage(SEPARATOR);
  const meta = [
    issue.status,
    issue.priority.name,
    issue.labels.join(", "),
    issue.project && intl.formatMessage(MESSAGES.project, { project: issue.project }),
    intl.formatMessage(MESSAGES.opened, { author: issue.createdBy, age: formatRelative(issue.createdAt, intl) }),
    issue.assignee && intl.formatMessage(MESSAGES.assigned, { assignee: issue.assignee }),
  ].filter(Boolean).join(` ${separator} `);
  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{intl.formatMessage(MESSAGES.title, { id: issue.id, title: issue.title })}</h2>
          <p className="mt-1 text-xs text-muted">{meta}</p>
        </div>
        {workspaceOf(issue.url) && (
          <Button variant="outline" size="sm" className="shrink-0" onPress={() => window.open(issue.url, "_blank", "noopener,noreferrer")}>
            <ExternalLink className="h-3.5 w-3.5" />
            {intl.formatMessage(MESSAGES.openInLinear)}
          </Button>
        )}
      </header>
      {run ? <RunView run={run} issue={issue} comments={comments} /> : <IssueBody issue={issue} comments={comments} onStarted={setStarted} />}
    </section>
  );
}

function IssueBody({ issue, comments, onStarted }: { issue: LinearIssueDetail; comments: LinearComment[]; onStarted: (run: LinearRun) => void }) {
  return (
    <>
      <Panels issue={issue} comments={comments} />
      <SolveCard issue={issue} onStarted={onStarted} />
    </>
  );
}

function RunView({ run, issue, comments }: { run: LinearRun; issue: LinearIssueDetail; comments: LinearComment[] }) {
  return (
    <>
      <Panels issue={issue} comments={comments} collapsible />
      <RunChat run={run} />
    </>
  );
}

function Panels({ issue, comments, collapsible }: { issue: LinearIssueDetail; comments: LinearComment[]; collapsible?: boolean }) {
  const intl = useOptionalIntl();
  return (
    <>
      <Panel title={intl.formatMessage(MESSAGES.description)} collapsible={collapsible}>
        {issue.description ? <Markdown text={issue.description} /> : <p className="text-sm text-muted">{intl.formatMessage(MESSAGES.noDescription)}</p>}
      </Panel>
      <Panel title={intl.formatMessage(MESSAGES.comments, { count: comments.length })} collapsible={collapsible}>
        <Comments comments={comments} />
      </Panel>
    </>
  );
}

function Panel({ title, collapsible, children }: { title: string; collapsible?: boolean; children: ReactNode }) {
  if (collapsible) {
    return (
      <details className="rounded-xl border border-border bg-surface">
        <summary className="cursor-pointer px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted">{title}</summary>
        <div className="px-4 pb-4">{children}</div>
      </details>
    );
  }
  return (
    <section className="rounded-xl border border-border bg-surface">
      <h3 className="px-4 pb-2 pt-3 text-xs font-medium uppercase tracking-wide text-muted">{title}</h3>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}

function Comments({ comments }: { comments: LinearComment[] }) {
  const intl = useOptionalIntl();
  const separator = intl.formatMessage(SEPARATOR);
  if (comments.length === 0) return <p className="text-sm text-muted">{intl.formatMessage(MESSAGES.noComments)}</p>;
  return (
    <ul className="flex flex-col gap-3">
      {comments.map((comment) => (
        <li key={comment.id} className="flex flex-col gap-1 text-sm">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span>{intl.formatMessage(MESSAGES.commentAuthor, { author: comment.author })}</span>
            <span>{separator}</span>
            <span>{formatRelative(comment.createdAt, intl)}</span>
          </div>
          <p className="whitespace-pre-wrap">{comment.body}</p>
        </li>
      ))}
      <li className="text-xs text-muted">{intl.formatMessage(MESSAGES.replyHint)}</li>
    </ul>
  );
}

function RunChat({ run }: { run: LinearRun }) {
  const scope = useMemo(() => ({ repository: run.repository, namespace: run.namespace }), [run.repository, run.namespace]);
  return (
    <section className="flex h-[70dvh] min-h-[28rem] flex-col overflow-hidden rounded-xl border border-border bg-surface">
      <RunHeader run={run} />
      <div className="min-h-0 flex-1">
        <AssistantPanel embedded scope={scope} conversation={run.conversation} />
      </div>
    </section>
  );
}

function RunHeader({ run }: { run: LinearRun }) {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const running = run.status === "running";
  const live = running || run.status === "awaiting_approval";
  const now = useNow(running);
  const stop = useMutation({
    mutationFn: () => Assistant.cancel(run.conversation),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: LINEAR_KEY });
      void qc.invalidateQueries({ queryKey: ["ai"] });
    },
  });
  const separator = intl.formatMessage(SEPARATOR);
  const status = intl.formatMessage(RUN_STATUS[run.status]);
  return (
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-muted">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="uppercase">{intl.formatMessage(MESSAGES.runHeader)}</span>
        <span>{separator}</span>
        <span className="uppercase">{run.repository}</span>
        <span>{separator}</span>
        <span className="uppercase">{running ? intl.formatMessage(MESSAGES.runTime, { status, time: elapsed(run.createdAt, now) }) : status}</span>
      </div>
      <div className="flex items-center gap-2">
        <Link to="/repositories/$name" params={{ name: run.repository }} search={{ ns: run.namespace, tab: "assistant", conversation: run.conversation }} className="text-accent hover:underline">
          {intl.formatMessage(MESSAGES.openAssistant)}
        </Link>
        {live && (
          <Button variant="ghost" size="sm" onPress={() => stop.mutate()} isDisabled={stop.isPending}>
            <Square className="h-3.5 w-3.5" />
            {intl.formatMessage(MESSAGES.stop)}
          </Button>
        )}
      </div>
    </header>
  );
}
