import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { Search } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { priorityLabel, statusDot } from "@/lib/linear";
import { useOptionalIntl } from "@/lib/i18n/format";
import { cn, formatRelative } from "@/lib/utils";
import type { LinearListIssue, LinearView } from "@/types";

const SCOPES: Record<string, MessageDescriptor> = defineMessages({
  mine: { id: "web.linear.scope_mine", defaultMessage: "Assigned to you", description: "Linear: scope text in the issue list header on the My issues tab" },
  team: { id: "web.linear.scope_team", defaultMessage: "Team {key}", description: "Linear: scope text in the issue list header on the Team tab; {key} is the team key" },
  all: { id: "web.linear.scope_all", defaultMessage: "Whole workspace", description: "Linear: scope text in the issue list header on the All issues tab" },
  review: { id: "web.linear.scope_review", defaultMessage: "In review", description: "Linear: scope text in the issue list header on the In review tab" },
  runs: { id: "web.linear.scope_runs", defaultMessage: "Linked to Assistant conversations", description: "Linear: scope text in the issue list header on the Assistant runs tab" },
});

const RUN_LABELS: Record<string, MessageDescriptor> = defineMessages({
  running: { id: "web.linear.run_solving", defaultMessage: "Assistant solving", description: "Linear: run state under an issue in the list while the Assistant works on it" },
  awaiting_approval: { id: "web.linear.run_waiting", defaultMessage: "Waiting for your approval", description: "Linear: run state under an issue in the list while the Assistant waits for approval" },
  idle: { id: "web.linear.run_finished", defaultMessage: "Assistant finished", description: "Linear: run state under an issue in the list after the Assistant finished" },
  error: { id: "web.linear.run_stopped", defaultMessage: "Assistant stopped", description: "Linear: run state under an issue in the list when the Assistant stopped with an error" },
});

const MESSAGES: Record<string, MessageDescriptor> = defineMessages({
  title: { id: "web.linear.list_title", defaultMessage: "Issues · {count}", description: "Linear: header of the issue list card; {count} is the number of loaded issues" },
  issue: { id: "web.linear.issue_title", defaultMessage: "{id} · {title}", description: "Linear: issue line in the list and detail header; {id} is the issue identifier such as CHK-142, {title} the issue title" },
  loading: { id: "web.linear.issues_loading", defaultMessage: "Loading issues…", description: "Linear: text in the issue list while the first page loads" },
  empty: { id: "web.linear.issues_empty", defaultMessage: "No issues match these filters", description: "Linear: empty state of the issue list when no issue matches the filters" },
  loadMore: { id: "web.linear.load_more", defaultMessage: "Load more", description: "Linear: button under the issue list that loads the next page of issues" },
  loadingMore: { id: "web.linear.loading_more", defaultMessage: "Loading…", description: "Linear: label of the load more button while the next page loads" },
});

const SEPARATOR = { id: "web.common.separator_dot", defaultMessage: "·", description: "Visual separator between two items" };

export function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function elapsed(since: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function IssueList({ view, teamKey, issues, selected, onSelect, pending, error, hasMore, loadingMore, onLoadMore }: {
  view: LinearView;
  teamKey: string;
  issues: LinearListIssue[];
  selected?: string;
  onSelect: (id: string) => void;
  pending: boolean;
  error: unknown;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const intl = useOptionalIntl();
  const now = useNow(issues.some((issue) => issue.run?.status === "running"));
  const separator = intl.formatMessage(SEPARATOR);
  const scope = view === "team" ? intl.formatMessage(SCOPES.team, { key: teamKey }) : intl.formatMessage(SCOPES[view]);
  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 text-xs text-muted">
        <span>{intl.formatMessage(MESSAGES.title, { count: issues.length })}</span>
        <span>{scope}</span>
      </header>
      {error ? <div className="p-3"><ErrorBanner err={error} /></div> : null}
      {pending && <p className="p-4 text-sm text-muted">{intl.formatMessage(MESSAGES.loading)}</p>}
      {!pending && !error && issues.length === 0 && <EmptyState icon={<Search />} title={intl.formatMessage(MESSAGES.empty)} />}
      <ul className="divide-y divide-border">
        {issues.map((issue) => {
          const active = issue.id === selected;
          const run = issue.run;
          const statusLine = [issue.status, issue.priority.name, issue.project, run && intl.formatMessage(RUN_LABELS[run.status])].filter(Boolean).join(` ${separator} `);
          return (
            <li key={issue.id}>
              <button type="button" aria-current={active || undefined} onClick={() => onSelect(issue.id)} className={cn("flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-default/40", active && "bg-accent/10")}>
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", statusDot(issue))} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{intl.formatMessage(MESSAGES.issue, { id: issue.id, title: issue.title })}</span>
                  <span className="block truncate text-xs text-muted">{statusLine}</span>
                </span>
                <span className="shrink-0 text-right text-xs text-muted">
                  <span className="block font-mono text-foreground">{run?.status === "running" ? elapsed(run.createdAt, now) : priorityLabel(issue.priority.value)}</span>
                  <span className="block">{formatRelative(issue.updatedAt, intl)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <div className="border-t border-border p-3">
          <Button variant="secondary" className="w-full" onPress={onLoadMore} isDisabled={loadingMore}>
            {intl.formatMessage(loadingMore ? MESSAGES.loadingMore : MESSAGES.loadMore)}
          </Button>
        </div>
      )}
    </section>
  );
}
