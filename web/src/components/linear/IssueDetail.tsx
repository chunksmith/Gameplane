import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { ExternalLink, FileText, MessageSquare, Sparkles, Square } from "lucide-react";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { Markdown } from "@/components/assistant/Markdown";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Assistant } from "@/lib/assistant";
import { useFormat, useOptionalIntl } from "@/lib/i18n/format";
import { Linear, LINEAR_KEY, statusDot, workspaceOf } from "@/lib/linear";
import { cn, formatRelative } from "@/lib/utils";
import type { LinearComment, LinearIssueDetail, LinearRun } from "@/types";
import { elapsed, useNow } from "./IssueList";
import { IssueDetailSkeleton } from "./Skeletons";
import { SolveCard } from "./SolveCard";

const MESSAGES: Record<string, MessageDescriptor> = defineMessages({
  title: { id: "web.linear.issue_title", defaultMessage: "{id} · {title}", description: "Linear: issue line in the list and detail header; {id} is the issue identifier such as CHK-142, {title} the issue title" },
  assignee: { id: "web.linear.detail_assignee", defaultMessage: "Assignee", description: "Linear: label of the assignee field in the issue detail header" },
  unassigned: { id: "web.linear.detail_unassigned", defaultMessage: "Unassigned", description: "Linear: assignee value in the issue detail header when nobody is assigned" },
  openedBy: { id: "web.linear.detail_opened_by", defaultMessage: "Opened by", description: "Linear: label of the author field in the issue detail header" },
  created: { id: "web.linear.detail_created", defaultMessage: "Created", description: "Linear: label of the creation time field in the issue detail header" },
  updated: { id: "web.linear.detail_updated", defaultMessage: "Updated", description: "Linear: label of the last update time field in the issue detail header" },
  openInLinear: { id: "web.linear.open_in_linear", defaultMessage: "Open in Linear", description: "Linear: button that opens the issue in Linear in a new tab" },
  loading: { id: "web.linear.detail_loading", defaultMessage: "Loading issue…", description: "Linear: screen-reader label of the issue detail placeholder while the issue loads" },
  description: { id: "web.linear.detail_description", defaultMessage: "Description", description: "Linear: heading of the issue description panel" },
  noDescription: { id: "web.linear.detail_no_description", defaultMessage: "No description", description: "Linear: text in the description panel when the issue has no description" },
  comments: { id: "web.linear.detail_comments", defaultMessage: "Comments", description: "Linear: heading of the comments panel; the number of comments is shown next to it in a badge" },
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

const PRIORITY_TONE: Partial<Record<number, [string, string]>> = {
  1: ["bg-danger-soft text-danger", "bg-danger"],
  2: ["bg-warning-soft text-warning-soft-foreground", "bg-warning"],
};

const initials = (name: string) => name.replace(/^@/, "").slice(0, 2).toUpperCase();

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
  if (!detail.data) return <IssueDetailSkeleton label={intl.formatMessage(MESSAGES.loading)} />;
  const { issue, comments } = detail.data;
  const run = detail.data.run ?? started;
  return (
    <section className="flex flex-col gap-3">
      <IssueHeader issue={issue} />
      {run ? <RunView run={run} issue={issue} comments={comments} /> : <IssueBody issue={issue} comments={comments} onStarted={setStarted} />}
    </section>
  );
}

function IssueHeader({ issue }: { issue: LinearIssueDetail }) {
  const intl = useOptionalIntl();
  const [tone, dot] = PRIORITY_TONE[issue.priority.value] ?? ["", "bg-muted"];
  return (
    <header className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="shrink-0 rounded-md bg-accent-soft px-2 py-0.5 font-mono text-xs font-medium text-accent-soft-foreground">{issue.id}</span>
          {issue.team && <span className="hidden truncate text-xs text-muted sm:inline">{issue.team}</span>}
        </div>
        {workspaceOf(issue.url) && (
          <Button variant="outline" size="sm" className="shrink-0" onPress={() => window.open(issue.url, "_blank", "noopener,noreferrer")}>
            {intl.formatMessage(MESSAGES.openInLinear)}
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <h2 aria-label={intl.formatMessage(MESSAGES.title, { id: issue.id, title: issue.title })} className="text-xl font-semibold leading-snug">{issue.title}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <Chip dot={statusDot(issue)}>{issue.status}</Chip>
        {issue.priority.value > 0 && <Chip dot={dot} className={tone}>{issue.priority.name}</Chip>}
        {issue.labels.map((label) => <Chip key={label} dot="bg-violet" className="bg-violet/15 text-violet">{label}</Chip>)}
        {issue.project && <Chip dot="bg-accent">{issue.project}</Chip>}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4 sm:grid-cols-4">
        <Meta label={intl.formatMessage(MESSAGES.assignee)} person={issue.assignee ?? undefined}>{issue.assignee ?? intl.formatMessage(MESSAGES.unassigned)}</Meta>
        <Meta label={intl.formatMessage(MESSAGES.openedBy)} person={issue.createdBy} avatarClass="bg-violet/15 text-violet">{intl.formatMessage(MESSAGES.commentAuthor, { author: issue.createdBy })}</Meta>
        <Meta label={intl.formatMessage(MESSAGES.created)}>{formatRelative(issue.createdAt, intl)}</Meta>
        <Meta label={intl.formatMessage(MESSAGES.updated)}>{formatRelative(issue.updatedAt, intl)}</Meta>
      </dl>
    </header>
  );
}

function Chip({ dot, className, children }: { dot: string; className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full bg-default px-2.5 py-1 text-xs font-medium", className)}>
      <span className={cn("h-2 w-2 rounded-full", dot)} />
      {children}
    </span>
  );
}

function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[9px] font-semibold text-accent-soft-foreground", className)}>
      {initials(name)}
    </span>
  );
}

function Meta({ label, person, avatarClass, children }: { label: string; person?: string; avatarClass?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <dt className="text-[11px] font-medium text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2 text-sm font-medium">
        {person && <Avatar name={person} className={avatarClass} />}
        <span className="truncate">{children}</span>
      </dd>
    </div>
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
  const format = useFormat();
  return (
    <>
      <Panel icon={<FileText className="h-3.5 w-3.5" />} title={intl.formatMessage(MESSAGES.description)} collapsible={collapsible}>
        {issue.description ? <Markdown text={issue.description} /> : <p className="text-sm text-muted">{intl.formatMessage(MESSAGES.noDescription)}</p>}
      </Panel>
      <Panel icon={<MessageSquare className="h-3.5 w-3.5" />} title={intl.formatMessage(MESSAGES.comments)} count={format.number(comments.length)} collapsible={collapsible}>
        <Comments comments={comments} />
      </Panel>
    </>
  );
}

function Panel({ icon, title, count, collapsible, children }: { icon: ReactNode; title: string; count?: string; collapsible?: boolean; children: ReactNode }) {
  const heading = (
    <span className="inline-flex items-center gap-2.5">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-default text-muted">{icon}</span>
      <span className="text-sm font-semibold">{title}</span>
      {count && <span className="rounded-full bg-default px-2 py-px text-[11px] font-medium text-muted">{count}</span>}
    </span>
  );
  if (collapsible) {
    return (
      <details className="rounded-xl border border-border bg-card">
        <summary className="cursor-pointer px-5 py-4">{heading}</summary>
        <div className="px-5 pb-5">{children}</div>
      </details>
    );
  }
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
      <h3>{heading}</h3>
      <div>{children}</div>
    </section>
  );
}

function Comments({ comments }: { comments: LinearComment[] }) {
  const intl = useOptionalIntl();
  if (comments.length === 0) return <p className="text-sm text-muted">{intl.formatMessage(MESSAGES.noComments)}</p>;
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-4">
        {comments.map((comment) => (
          <li key={comment.id} className="flex gap-3">
            <Avatar name={comment.author} className="h-8 w-8 text-[10px] bg-violet/15 text-violet" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-semibold">{intl.formatMessage(MESSAGES.commentAuthor, { author: comment.author })}</span>
                <span className="text-xs text-muted">{formatRelative(comment.createdAt, intl)}</span>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-sm">{comment.body}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-xs text-muted">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />
        {intl.formatMessage(MESSAGES.replyHint)}
      </p>
    </div>
  );
}

function RunChat({ run }: { run: LinearRun }) {
  const scope = useMemo(() => ({ repository: run.repository, namespace: run.namespace }), [run.repository, run.namespace]);
  return (
    <section className="flex h-[70dvh] min-h-[28rem] flex-col overflow-hidden rounded-xl border border-border bg-card">
      <RunHeader run={run} />
      <div className="min-h-0 flex-1">
        <AssistantPanel key={run.conversation} embedded scope={scope} conversation={run.conversation} />
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
