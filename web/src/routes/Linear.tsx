import { useEffect, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, ListBox, ListBoxItem, Select, Tab, Tabs } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { ExternalLink, RefreshCw, Search } from "lucide-react";
import { LinearLogo } from "@/components/assistant/LinearLogo";
import { IssueDetail } from "@/components/linear/IssueDetail";
import { IssueList } from "@/components/linear/IssueList";
import { RepositoryLinks } from "@/components/linear/RepositoryLinks";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingCard } from "@/components/ui/LoadingCard";
import { useAssistantStatus } from "@/lib/assistant";
import { useOptionalIntl } from "@/lib/i18n/format";
import { Linear, LINEAR_KEY, workspaceOf, type LinearListQuery } from "@/lib/linear";
import { cn, formatRelative } from "@/lib/utils";
import type { LinearView } from "@/types";

const TABS = ["mine", "team", "all", "review", "runs", "links"] as const;
type LinearTab = (typeof TABS)[number];

const STATUS_OPTIONS = ["Todo", "In Progress", "In Review", "Backlog", "Done"] as const;
const DEFAULT_STATUSES: string[] = ["Todo", "In Progress", "In Review"];

const TAB_LABELS: Record<string, MessageDescriptor> = defineMessages({
  mine: { id: "web.linear.tab_mine", defaultMessage: "My issues", description: "Linear: tab with the issues assigned to the signed-in user" },
  team: { id: "web.linear.tab_team", defaultMessage: "Team", description: "Linear: tab with the issues of the selected team; also the label of the team select" },
  all: { id: "web.linear.tab_all", defaultMessage: "All issues", description: "Linear: tab with every issue in the workspace" },
  review: { id: "web.linear.tab_review", defaultMessage: "In review", description: "Linear: tab with the issues in review" },
  runs: { id: "web.linear.tab_runs", defaultMessage: "Assistant runs", description: "Linear: tab with the issues the Assistant has worked on" },
  links: { id: "web.linear.tab_links", defaultMessage: "Repository links", description: "Linear: tab that maps Linear projects to repositories" },
});

const STATUS_LABELS: Record<string, MessageDescriptor> = defineMessages({
  "Todo": { id: "web.linear.status_todo", defaultMessage: "Todo", description: "Linear: status filter chip for issues in the Todo state" },
  "In Progress": { id: "web.linear.status_in_progress", defaultMessage: "In Progress", description: "Linear: status filter chip for issues in progress" },
  "In Review": { id: "web.linear.status_in_review", defaultMessage: "In Review", description: "Linear: status filter chip for issues in review" },
  "Backlog": { id: "web.linear.status_backlog", defaultMessage: "Backlog", description: "Linear: status filter chip for issues in the Backlog state" },
  "Done": { id: "web.linear.status_done", defaultMessage: "Done", description: "Linear: status filter chip for completed issues" },
});

const MESSAGES: Record<string, MessageDescriptor> = defineMessages({
  title: { id: "web.linear.title", defaultMessage: "Linear", description: "Linear: page title next to the Linear logo; product name" },
  meta: { id: "web.linear.meta", defaultMessage: "team {team} ({key}) · synced {when}", description: "Linear: muted header text with the selected team and when the issues were last synced" },
  refresh: { id: "web.linear.refresh", defaultMessage: "Refresh", description: "Linear: button that reloads issues and projects from Linear" },
  openLinear: { id: "web.linear.open_linear", defaultMessage: "Open Linear", description: "Linear: button that opens the workspace in Linear in a new tab" },
  tabCount: { id: "web.linear.tab_count", defaultMessage: "{label} · {count}", description: "Linear: active issue tab label with the number of loaded issues; {label} is the tab name, {count} the number" },
  tabsLabel: { id: "web.linear.tabs", defaultMessage: "Linear views", description: "Linear: accessible name of the row of tabs; not shown as text" },
  teamOption: { id: "web.linear.team_option", defaultMessage: "{name} ({key})", description: "Linear: team option in the team select; {name} is the team name, {key} its short key" },
  status: { id: "web.linear.status", defaultMessage: "Status", description: "Linear: label in front of the status filter chips" },
  sort: { id: "web.linear.sort", defaultMessage: "Sort", description: "Linear: label of the sort select" },
  sortPriority: { id: "web.linear.sort_priority", defaultMessage: "Priority", description: "Linear: sort option that orders issues by priority" },
  sortUpdated: { id: "web.linear.sort_updated", defaultMessage: "Updated", description: "Linear: sort option that orders issues by last update" },
  search: { id: "web.linear.search", defaultMessage: "Search issues", description: "Linear: placeholder and accessible name of the issue search box" },
  back: { id: "web.linear.back", defaultMessage: "← Issues", description: "Linear: button on small screens that returns from an issue to the issue list" },
  selectIssue: { id: "web.linear.select_issue", defaultMessage: "Select an issue to see its details", description: "Linear: empty state on desktop when no issue is selected" },
  loading: { id: "web.linear.loading", defaultMessage: "Loading…", description: "Linear: loading text while the Linear status is checked" },
  notConnected: { id: "web.linear.not_connected", defaultMessage: "Linear is not connected", description: "Linear: empty state title when the Assistant or Linear integration is off" },
  connectHint: { id: "web.linear.connect_hint", defaultMessage: "Connect your Linear API key in Settings → Integrations", description: "Linear: empty state hint explaining where to connect the Linear API key" },
  openIntegrations: { id: "web.linear.open_integrations", defaultMessage: "Open Integrations", description: "Linear: link to the Integrations settings page where the Linear API key is stored" },
});

export function LinearPage() {
  const intl = useOptionalIntl();
  const nav = useNavigate();
  const qc = useQueryClient();
  const search = useSearch({ from: "/app-layout/linear" });
  const assistant = useAssistantStatus();
  const linear = assistant.data?.enabled === true && assistant.data.configured === true && assistant.data.linear === true;
  const [teamId, setTeamId] = useState<string>();
  const [statuses, setStatuses] = useState<string[]>(DEFAULT_STATUSES);
  const [sort, setSort] = useState<"priority" | "updated">("priority");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);
  const teams = useQuery({ queryKey: [...LINEAR_KEY, "teams"], queryFn: () => Linear.teams(), enabled: linear });
  const team = teams.data?.find((item) => item.id === teamId) ?? teams.data?.[0];
  const tab: LinearTab = TABS.find((key) => key === search.tab) ?? "mine";
  const view: LinearView = tab === "links" ? "mine" : tab;
  const query: LinearListQuery = { view, team: view === "all" || view === "runs" ? undefined : team?.id, status: statuses, q: debouncedQ || undefined, sort };
  const issues = useInfiniteQuery({
    queryKey: [...LINEAR_KEY, "issues", query],
    queryFn: ({ pageParam }) => Linear.issues({ ...query, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.cursor ?? undefined,
    refetchInterval: 60_000,
    enabled: linear && tab !== "links" && (view !== "team" || !!team),
  });

  if (assistant.isPending) return <div className="p-4 sm:p-6"><LoadingCard message={intl.formatMessage(MESSAGES.loading)} /></div>;
  if (!linear) {
    return (
      <div className="p-4 sm:p-6">
        <EmptyState
          icon={<LinearLogo className="h-5 w-5" />}
          title={intl.formatMessage(MESSAGES.notConnected)}
          hint={intl.formatMessage(MESSAGES.connectHint)}
          action={<Link to="/settings/integrations" className="text-sm text-accent hover:underline">{intl.formatMessage(MESSAGES.openIntegrations)}</Link>}
        />
      </div>
    );
  }

  const list = issues.data?.pages.flatMap((page) => page.issues) ?? [];
  const workspace = workspaceOf(list[0]?.url ?? "");
  const issueId = search.issue;
  const syncedAt = issues.dataUpdatedAt ? formatRelative(new Date(issues.dataUpdatedAt).toISOString(), intl) : "";
  const meta = team ? intl.formatMessage(MESSAGES.meta, { team: team.name, key: team.key, when: syncedAt }) : "";
  const label = (key: LinearTab) => (key === tab && key !== "links" ? intl.formatMessage(MESSAGES.tabCount, { label: intl.formatMessage(TAB_LABELS[key]), count: list.length }) : intl.formatMessage(TAB_LABELS[key]));

  function go(next: { tab?: LinearTab; issue?: string }) {
    void nav({ to: "/linear", search: (prev) => ({ ...prev, ...next }) });
  }

  function refresh() {
    void qc.invalidateQueries({ queryKey: LINEAR_KEY });
  }

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface">
          <LinearLogo className="h-5 w-5" />
        </span>
        <h1 className="font-mono text-lg font-semibold">{intl.formatMessage(MESSAGES.title)}</h1>
        {workspace && <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-xs text-accent">{workspace}</span>}
        {meta && <span className="hidden text-xs text-muted md:inline">{meta}</span>}
        <div className="ml-auto hidden items-center gap-2 sm:flex">
          <Button variant="ghost" size="sm" onPress={refresh}>
            <RefreshCw className="h-4 w-4" />
            {intl.formatMessage(MESSAGES.refresh)}
          </Button>
          {workspace && (
            <Button variant="outline" size="sm" onPress={() => window.open(`https://linear.app/${workspace}`, "_blank", "noopener,noreferrer")}>
              <ExternalLink className="h-3.5 w-3.5" />
              {intl.formatMessage(MESSAGES.openLinear)}
            </Button>
          )}
        </div>
      </header>

      <nav className="-mb-px overflow-x-auto scrollbar-thin">
        <Tabs selectedKey={tab} onSelectionChange={(key) => go({ tab: key as LinearTab, issue: undefined })} className="server-detail-tabs">
          <Tabs.List aria-label={intl.formatMessage(MESSAGES.tabsLabel)}>
            {TABS.map((key) => (
              <Tab key={key} id={key}>
                {label(key)}
                <Tabs.Indicator />
              </Tab>
            ))}
          </Tabs.List>
        </Tabs>
      </nav>

      {tab !== "links" && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="hidden text-xs text-muted sm:inline">{intl.formatMessage(TAB_LABELS.team)}</span>
          <Select aria-label={intl.formatMessage(TAB_LABELS.team)} value={team?.id ?? ""} onChange={(next) => setTeamId(String(next ?? ""))} className="min-w-40">
            <Select.Trigger className="w-full items-center rounded border border-border bg-surface px-3 py-1.5 text-sm">
              <Select.Value />
              <Select.Indicator className="ml-auto h-4 w-4" />
            </Select.Trigger>
            <Select.Popover className="rounded border border-border">
              <ListBox className="p-0">
                {teams.data?.map((item) => {
                  const name = intl.formatMessage(MESSAGES.teamOption, { name: item.name, key: item.key });
                  return <ListBoxItem key={item.id} id={item.id} textValue={name}>{name}</ListBoxItem>;
                })}
              </ListBox>
            </Select.Popover>
          </Select>
          <span className="hidden text-xs text-muted md:inline">{intl.formatMessage(MESSAGES.status)}</span>
          <div className="hidden flex-wrap items-center gap-1.5 md:flex">
            {STATUS_OPTIONS.map((value) => {
              const on = statuses.includes(value);
              return (
                <Button key={value} size="sm" variant={on ? "secondary" : "ghost"} aria-pressed={on} onPress={() => setStatuses(on ? statuses.filter((item) => item !== value) : [...statuses, value])}>
                  {intl.formatMessage(STATUS_LABELS[value])}
                </Button>
              );
            })}
          </div>
          <span className="hidden text-xs text-muted md:inline">{intl.formatMessage(MESSAGES.sort)}</span>
          <Select aria-label={intl.formatMessage(MESSAGES.sort)} value={sort} onChange={(next) => setSort(next === "updated" ? "updated" : "priority")} className="hidden min-w-32 md:block">
            <Select.Trigger className="w-full items-center rounded border border-border bg-surface px-3 py-1.5 text-sm">
              <Select.Value />
              <Select.Indicator className="ml-auto h-4 w-4" />
            </Select.Trigger>
            <Select.Popover className="rounded border border-border">
              <ListBox className="p-0">
                <ListBoxItem id="priority" textValue={intl.formatMessage(MESSAGES.sortPriority)}>{intl.formatMessage(MESSAGES.sortPriority)}</ListBoxItem>
                <ListBoxItem id="updated" textValue={intl.formatMessage(MESSAGES.sortUpdated)}>{intl.formatMessage(MESSAGES.sortUpdated)}</ListBoxItem>
              </ListBox>
            </Select.Popover>
          </Select>
          <div className="ml-auto hidden items-center gap-2 md:flex">
            <Button isIconOnly variant="ghost" size="sm" aria-label={intl.formatMessage(MESSAGES.refresh)} onPress={refresh}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <div className="relative w-56">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/60" />
              <Input value={q} onChange={(event) => setQ(event.target.value)} className="w-full pl-9" placeholder={intl.formatMessage(MESSAGES.search)} aria-label={intl.formatMessage(MESSAGES.search)} />
            </div>
          </div>
        </div>
      )}

      {tab === "links" ? (
        <RepositoryLinks />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
          <div className={cn("min-w-0", issueId && "hidden lg:block")}>
            <IssueList
              view={view}
              teamKey={team?.key ?? ""}
              issues={list}
              selected={issueId}
              onSelect={(id) => go({ issue: id })}
              pending={issues.isPending}
              error={issues.error}
              hasMore={issues.hasNextPage}
              loadingMore={issues.isFetchingNextPage}
              onLoadMore={() => void issues.fetchNextPage()}
            />
          </div>
          <div className={cn("min-w-0", !issueId && "hidden lg:block")}>
            {issueId ? (
              <>
                <button type="button" onClick={() => go({ issue: undefined })} className="mb-3 text-sm text-accent lg:hidden">{intl.formatMessage(MESSAGES.back)}</button>
                <IssueDetail key={issueId} id={issueId} />
              </>
            ) : (
              <EmptyState icon={<LinearLogo className="h-5 w-5" />} title={intl.formatMessage(MESSAGES.selectIssue)} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
