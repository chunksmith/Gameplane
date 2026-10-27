import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Input, ListBox, ListBoxItem, Select } from "@heroui/react";
import {
  Activity,
  Archive,
  Check,
  ChevronRight,
  FileText,
  FolderGit2,
  GitCommitHorizontal,
  GitCompare,
  Loader2,
  Lock,
  MessageSquarePlus,
  Package,
  PanelLeft,
  Search,
  Send,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Users,
  X,
} from "lucide-react";
import { AttachButton, AttachmentTray, MessageAttachments, useAttachments } from "@/components/assistant/Attachments";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LinearLogo } from "@/components/assistant/LinearLogo";
import { Markdown } from "@/components/assistant/Markdown";
import { MentionTextArea, mentionContext } from "@/components/assistant/Mentions";
import { QueuedMessages, useMessageQueue } from "@/components/assistant/MessageQueue";
import { ModelPicker } from "@/components/assistant/ModelPicker";
import { BackgroundActions, PlanCard, QuestionCard, SubagentCard, TasksCard } from "@/components/assistant/ToolCards";
import { can, useMe } from "@/lib/auth";
import { cn, formatRelative } from "@/lib/utils";
import {
  ASSISTANT_MODES,
  Assistant,
  LINEAR_METHOD,
  blocksOf,
  callLabel,
  jobIdOf,
  jobStatus,
  latestTodos,
  linearArgument,
  linearMentions,
  linearTool,
  modelLabel,
  requestOf,
  resultCount,
  resultStatus,
  resultText,
  scopeQuery,
  toolView,
  useAssistantStatus,
  useAssistantStream,
  withContextBlock,
  type AssistantAttachment,
  type AssistantBlock,
  type AssistantConversation,
  type AssistantDetail,
  type AssistantMessage,
  type AssistantMode,
  type AssistantPick,
  type AssistantScope,
  type JobStatus,
  type ToolView,
} from "@/lib/assistant";
import { useFormat, useOptionalIntl } from "@/lib/i18n/format";
import { defineMessages, type MessageDescriptor } from "react-intl";

const statusTone: Record<AssistantConversation["status"], string> = {
  running: "bg-accent",
  awaiting_approval: "bg-warning",
  idle: "bg-success",
  error: "bg-danger",
};

const statusLabel: Record<AssistantConversation["status"], MessageDescriptor> = defineMessages({
  running: { id: "web.components.assistant.assistant_panel.status_working", defaultMessage: "Working", description: "Assistant panel: status chip for a conversation whose reply is still running; keep it short" },
  awaiting_approval: { id: "web.components.assistant.assistant_panel.status_needs_approval", defaultMessage: "Needs approval", description: "Assistant panel: status chip for a conversation waiting for the user to approve actions; keep it short" },
  idle: { id: "web.components.assistant.assistant_panel.status_done", defaultMessage: "Done", description: "Assistant panel: status chip for a conversation whose reply has finished; keep it short" },
  error: { id: "web.components.assistant.assistant_panel.status_stopped", defaultMessage: "Stopped", description: "Assistant panel: status chip for a conversation that stopped with an error; keep it short" },
});

const methodTone: Record<string, string> = {
  GET: "bg-link/10 text-link",
  POST: "bg-success/10 text-success",
  PUT: "bg-warning/10 text-warning",
  PATCH: "bg-warning/10 text-warning",
  DELETE: "bg-danger/10 text-danger",
};

interface Starter {
  icon: ReactNode;
  title: MessageDescriptor;
  prompt: MessageDescriptor;
}

const STARTER_MESSAGES = defineMessages({
  checkHealthTitle: { id: "web.components.assistant.assistant_panel.check_health", defaultMessage: "Check health", description: "Assistant panel: title of a starter card that asks the assistant about the server status; keep it short" },
  checkHealthPrompt: { id: "web.components.assistant.assistant_panel.what_is_this_server_s_status", defaultMessage: "What is this server's status?", description: "Assistant panel: message put in the message box when the Check health starter card is clicked, asking for the server status" },
  readConfigTitle: { id: "web.components.assistant.assistant_panel.read_the_config", defaultMessage: "Read the config", description: "Assistant panel: title of a starter card that asks the assistant to show the server config; keep it short" },
  readConfigPrompt: { id: "web.components.assistant.assistant_panel.show_me_server_properties", defaultMessage: "Show me server.properties", description: "Assistant panel: message put in the message box when the Read the config starter card is clicked; server.properties is a file name, keep it as is" },
  auditPluginsTitle: { id: "web.components.assistant.assistant_panel.audit_plugins", defaultMessage: "Audit plugins", description: "Assistant panel: title of a starter card that asks the assistant which plugins are installed; keep it short" },
  auditPluginsPrompt: { id: "web.components.assistant.assistant_panel.which_plugins_are_installed", defaultMessage: "Which plugins are installed?", description: "Assistant panel: message put in the message box when the Audit plugins starter card is clicked" },
  listServersTitle: { id: "web.components.assistant.assistant_panel.list_servers", defaultMessage: "List servers", description: "Assistant panel: title of a fleet starter card that asks the assistant to list all servers; keep it short" },
  listServersPrompt: { id: "web.components.assistant.assistant_panel.list_all_my_servers", defaultMessage: "List all my servers", description: "Assistant panel: message put in the message box when the List servers starter card is clicked" },
  findOutagesTitle: { id: "web.components.assistant.assistant_panel.find_outages", defaultMessage: "Find outages", description: "Assistant panel: title of a fleet starter card that asks which servers are offline; keep it short" },
  findOutagesPrompt: { id: "web.components.assistant.assistant_panel.which_servers_are_offline", defaultMessage: "Which servers are offline?", description: "Assistant panel: message put in the message box when the Find outages starter card is clicked" },
  checkBackupsTitle: { id: "web.components.assistant.assistant_panel.check_backups", defaultMessage: "Check backups", description: "Assistant panel: title of a fleet starter card that asks for the latest backups; keep it short" },
  reviewChangesTitle: { id: "web.repositories.assistant.review_changes", defaultMessage: "Review changes", description: "Repository assistant: title of a starter card that asks the assistant to review the uncommitted changes; keep it short" },
  reviewChangesPrompt: { id: "web.repositories.assistant.review_changes_prompt", defaultMessage: "Review my uncommitted changes", description: "Repository assistant: message put in the message box when the Review changes starter card is clicked" },
  writeCommitTitle: { id: "web.repositories.assistant.write_commit", defaultMessage: "Write a commit", description: "Repository assistant: title of a starter card that asks the assistant to write a commit message and commit; keep it short" },
  writeCommitPrompt: { id: "web.repositories.assistant.write_commit_prompt", defaultMessage: "Write a commit message for the staged changes and commit them", description: "Repository assistant: message put in the message box when the Write a commit starter card is clicked" },
  explainRepositoryTitle: { id: "web.repositories.assistant.explain_repository", defaultMessage: "Explain the project", description: "Repository assistant: title of a starter card that asks the assistant to explain how the repository is laid out; keep it short" },
  explainRepositoryPrompt: { id: "web.repositories.assistant.explain_repository_prompt", defaultMessage: "Explain how this repository is organized", description: "Repository assistant: message put in the message box when the Explain the project starter card is clicked" },
  checkBackupsPrompt: { id: "web.components.assistant.assistant_panel.show_the_latest_backups", defaultMessage: "Show the latest backups", description: "Assistant panel: message put in the message box when the Check backups starter card is clicked" },
});

const serverStarters: Starter[] = [
  { icon: <Activity />, title: STARTER_MESSAGES.checkHealthTitle, prompt: STARTER_MESSAGES.checkHealthPrompt },
  { icon: <FileText />, title: STARTER_MESSAGES.readConfigTitle, prompt: STARTER_MESSAGES.readConfigPrompt },
  { icon: <Package />, title: STARTER_MESSAGES.auditPluginsTitle, prompt: STARTER_MESSAGES.auditPluginsPrompt },
];

const repositoryStarters: Starter[] = [
  { icon: <GitCompare />, title: STARTER_MESSAGES.reviewChangesTitle, prompt: STARTER_MESSAGES.reviewChangesPrompt },
  { icon: <GitCommitHorizontal />, title: STARTER_MESSAGES.writeCommitTitle, prompt: STARTER_MESSAGES.writeCommitPrompt },
  { icon: <FileText />, title: STARTER_MESSAGES.explainRepositoryTitle, prompt: STARTER_MESSAGES.explainRepositoryPrompt },
];

const fleetStarters: Starter[] = [
  { icon: <Server />, title: STARTER_MESSAGES.listServersTitle, prompt: STARTER_MESSAGES.listServersPrompt },
  { icon: <Activity />, title: STARTER_MESSAGES.findOutagesTitle, prompt: STARTER_MESSAGES.findOutagesPrompt },
  { icon: <Archive />, title: STARTER_MESSAGES.checkBackupsTitle, prompt: STARTER_MESSAGES.checkBackupsPrompt },
];

const DAY_GROUPS = ["Today", "Yesterday", "Earlier"] as const;

type DayGroup = (typeof DAY_GROUPS)[number];

const dayGroupLabel: Record<DayGroup, MessageDescriptor> = defineMessages({
  Today: { id: "web.components.assistant.assistant_panel.day_today", defaultMessage: "Today", description: "Assistant panel: heading above the conversations updated today in the list; keep it short" },
  Yesterday: { id: "web.components.assistant.assistant_panel.day_yesterday", defaultMessage: "Yesterday", description: "Assistant panel: heading above the conversations updated yesterday in the list; keep it short" },
  Earlier: { id: "web.components.assistant.assistant_panel.day_earlier", defaultMessage: "Earlier", description: "Assistant panel: heading above the conversations updated before yesterday in the list; keep it short" },
});

function dayGroup(iso: string): DayGroup {
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(new Date(iso))) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return "Earlier";
}

const assistantAvatar = (
  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent ring-1 ring-accent/20">
    <Sparkles className="h-4 w-4" />
  </span>
);

const chipClass = "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 text-xs text-muted";

export function AssistantPanel({ scope = {} }: { scope?: AssistantScope }) {
  const intl = useOptionalIntl();
  const fmt = useFormat();
  const dotSeparator = intl.formatMessage({ id: "web.common.separator_dot", defaultMessage: "·", description: "Visual separator between two items" });
  const status = useAssistantStatus();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [search, setSearch] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [pickedMode, setPickedMode] = useState<AssistantMode>();
  const [pickedModel, setPickedModel] = useState<AssistantPick>();
  const attachments = useAttachments();
  const ready = !!status.data?.enabled && status.data.configured;

  const list = useQuery({
    queryKey: ["ai", "conversations", scopeQuery(scope, all)],
    queryFn: () => Assistant.list(scope, all),
    enabled: ready,
    refetchInterval: (query) => (query.state.data?.some((c) => c.status === "running") ? 3000 : false),
  });
  const detail = useQuery({
    queryKey: ["ai", "conversation", selected],
    queryFn: () => Assistant.get(selected ?? ""),
    enabled: ready && !!selected,
    refetchInterval: (query) => (query.state.data?.conversation.status === "running" ? 1500 : false),
  });
  const tail = useAssistantStream(selected, detail.data?.conversation.status === "running", () =>
    qc.invalidateQueries({ queryKey: ["ai", "conversation", selected] }),
  );

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = (list.data ?? []).filter((c) => !needle || c.title.toLowerCase().includes(needle));
    return DAY_GROUPS.map((label) => ({ label, items: matches.filter((c) => dayGroup(c.updatedAt) === label) })).filter(
      (group) => group.items.length > 0,
    );
  }, [list.data, search]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["ai"] });
  const submit = useMutation({
    mutationFn: async ({ text, files }: { text: string; files?: AssistantAttachment[] }) => {
      const body = withContextBlock(text, await mentionContext(scope, text));
      return selected ? Assistant.send(selected, body, pickedMode, pickedModel, files) : Assistant.create(body, scope, pickedMode, pickedModel, files);
    },
    onSuccess: (conv) => {
      setSelected(conv.id);
      refresh();
    },
  });
  const warmStatus = selected ? detail.data?.conversation.status : "idle";
  useEffect(() => {
    if (!ready || !warmStatus || warmStatus === "running" || warmStatus === "awaiting_approval") return;
    const warmScope = { server: scope.server, namespace: scope.namespace, cluster: scope.cluster };
    void Assistant.warm(selected, warmScope, pickedMode, pickedModel).catch(() => undefined);
  }, [ready, selected, warmStatus, scope.server, scope.namespace, scope.cluster, pickedMode, pickedModel]);
  const decide = useMutation({ mutationFn: (approve: boolean) => Assistant.decide(selected ?? "", approve), onSuccess: refresh });
  const stop = useMutation({ mutationFn: () => Assistant.cancel(selected ?? ""), onSuccess: refresh });
  const queue = useMessageQueue(warmStatus === "running" || warmStatus === "awaiting_approval", (text) => submit.mutate({ text }), () => stop.mutate());

  if (status.isLoading) {
    return <div className="flex items-center gap-2 p-6 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />{intl.formatMessage({ id: "web.components.assistant.assistant_panel.loading_assistant", defaultMessage: "Loading assistant…", description: "Assistant panel: loading text shown in place of the panel while the assistant status is fetched" })}</div>;
  }
  if (!status.data?.enabled) {
    return <EmptyState icon={<Sparkles />} title={intl.formatMessage({ id: "web.components.assistant.assistant_panel.the_ai_assistant_is_turned_off", defaultMessage: "The AI assistant is turned off", description: "Assistant panel: title of the empty state shown when an admin has turned the AI assistant off" })} hint={intl.formatMessage({ id: "web.components.assistant.assistant_panel.an_admin_can_turn_it_on_under_admin", defaultMessage: "An admin can turn it on under Admin settings → AI assistant.", description: "Assistant panel: hint under the title when the AI assistant is turned off, telling the user who can enable it and where" })} />;
  }
  if (!status.data.configured) {
    return <EmptyState icon={<Sparkles />} title={intl.formatMessage({ id: "web.components.assistant.assistant_panel.no_claude_api_key_yet", defaultMessage: "No Claude API key yet", description: "Assistant panel: title of the empty state shown when no Claude API key is configured yet" })} hint={intl.formatMessage({ id: "web.components.assistant.assistant_panel.an_admin_needs_to_add_a_claude_api_key", defaultMessage: "An admin needs to add a Claude API key under Admin settings → AI assistant.", description: "Assistant panel: hint under the title when no Claude API key is configured, telling the user an admin must add one and where" })} />;
  }

  const conv = selected ? detail.data?.conversation : undefined;
  const own = !conv || conv.userId === me?.id;
  const running = conv?.status === "running";
  const busy = running || conv?.status === "awaiting_approval" || submit.isPending;
  const scoped = scope.server ?? scope.repository;
  const starters = scope.repository ? repositoryStarters : scope.server ? serverStarters : fleetStarters;
  const pending = detail.data?.pending ?? [];
  const approvals = pending.filter((p) => p.method !== "ASK" && p.method !== "PLAN");
  const mode = pickedMode ?? conv?.mode ?? status.data.defaultMode;
  const model = pickedModel ?? (conv ? { model: conv.model, effort: conv.effort } : { model: status.data.defaultModel, effort: status.data.defaultEffort });
  const modeLabel = intl.formatMessage({ id: "web.components.assistant.assistant_panel.permission_mode", defaultMessage: "Permission mode", description: "Assistant panel: accessible name of the dropdown above the message box that picks how the assistant asks for approval; keep it short" });
  const open = (id: string | null) => {
    setSelected(id);
    queue.drain();
    setPickedMode(undefined);
    setPickedModel(undefined);
    setListOpen(false);
  };
  const send = () => {
    const text = prompt.trim();
    if (!text || (busy && attachments.items.length > 0)) return;
    if (busy) {
      queue.add(text);
      setPrompt("");
    } else
      submit.mutate({ text, files: attachments.items }, {
        onSuccess: () => {
          setPrompt("");
          attachments.clear();
        },
      });
  };
  const interrupt = () => {
    setPrompt([...queue.drain(), prompt].filter(Boolean).join("\n\n"));
    stop.mutate();
  };
  const actionError = submit.error ?? decide.error ?? stop.error;
  const subtitle = conv
    ? [conv.server || conv.repository || intl.formatMessage({ id: "web.components.assistant.assistant_panel.all_servers", defaultMessage: "All servers", description: "Assistant panel: server shown under the title of a conversation that is not tied to one server; keep it short" }), conv.namespace, all && conv.username].filter(Boolean).join(` ${dotSeparator} `)
    : scoped
      ? [scoped, scope.namespace].filter(Boolean).join(` ${dotSeparator} `)
      : intl.formatMessage({ id: "web.components.assistant.assistant_panel.all_servers_you_can_access", defaultMessage: "All servers you can access", description: "Assistant panel: subtitle under the title of a new conversation that is not tied to one server" });

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card className={cn("border border-border bg-surface/60 lg:sticky lg:top-4 lg:self-start", !listOpen && "hidden lg:block")}>
        <Card.Content className="space-y-2.5 p-3">
          <Button variant="primary" className="w-full justify-center" onPress={() => open(null)}>
            <MessageSquarePlus className="h-4 w-4" />{intl.formatMessage({ id: "web.components.assistant.assistant_panel.new_conversation", defaultMessage: "New conversation", description: "Assistant panel: label of the button that starts a new conversation, also the header title of an unsaved chat; keep it short" })}
          </Button>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={intl.formatMessage({ id: "web.components.assistant.assistant_panel.search_conversations", defaultMessage: "Search conversations…", description: "Assistant panel: placeholder of the search box that filters the conversation list by title; keep it short" })}
              aria-label={intl.formatMessage({ id: "web.components.assistant.assistant_panel.search_conversations_label", defaultMessage: "Search conversations", description: "Assistant panel: accessible name of the conversation search box; keep it short" })}
              className="w-full pl-8"
            />
          </div>
          {can(me, "audit:read") && (
            <div className="flex gap-1.5">
              <Button size="sm" variant={all ? "ghost" : "secondary"} aria-pressed={!all} onPress={() => setAll(false)}>{intl.formatMessage({ id: "web.components.assistant.assistant_panel.mine", defaultMessage: "Mine", description: "Assistant panel: filter button that shows only the signed-in user's conversations; keep it short" })}</Button>
              <Button size="sm" variant={all ? "secondary" : "ghost"} aria-pressed={all} onPress={() => setAll(true)}>
                <Users className="h-3.5 w-3.5" />{intl.formatMessage({ id: "web.components.assistant.assistant_panel.all_users", defaultMessage: "All users", description: "Assistant panel: filter button that shows conversations of all users, offered to users who can read the audit log; keep it short" })}
              </Button>
            </div>
          )}
          <ul className="max-h-64 space-y-0.5 overflow-y-auto scrollbar-thin lg:max-h-[26rem]" aria-label={intl.formatMessage({ id: "web.components.assistant.assistant_panel.conversations", defaultMessage: "Conversations", description: "Assistant panel: name of the conversation list, used as its accessible name and as the label of the mobile button that opens it; keep it short" })}>
            {groups.length === 0 && (
              <li className="px-2 py-6 text-center text-xs text-muted">{search.trim() ? intl.formatMessage({ id: "web.components.assistant.assistant_panel.no_matching_conversations", defaultMessage: "No matching conversations", description: "Assistant panel: text in the conversation list when the search matches nothing" }) : intl.formatMessage({ id: "web.components.assistant.assistant_panel.no_conversations_yet", defaultMessage: "No conversations yet", description: "Assistant panel: text in the conversation list when the user has no conversations" })}</li>
            )}
            {groups.map((group) => (
              <li key={group.label}>
                <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted first:pt-1">{intl.formatMessage(dayGroupLabel[group.label])}</p>
                <ul className="space-y-0.5">
                  {group.items.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => open(c.id)}
                        aria-current={c.id === selected ? "true" : undefined}
                        className={cn(
                          "flex w-full gap-2.5 overflow-hidden rounded-xl pr-3 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent",
                          c.id === selected ? "bg-accent/10" : "hover:bg-foreground/5",
                        )}
                      >
                        <span className={cn("w-0.5 shrink-0 rounded-full", c.id === selected && "bg-accent")} />
                        <span className="min-w-0 flex-1 py-2">
                          <span className="block truncate text-sm font-medium">{c.title}</span>
                          <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusTone[c.status], c.status === "running" && "animate-pulse")} />
                            <span className="truncate">
                              {[all ? c.username : "", all && c.server ? c.server : "", intl.formatMessage(statusLabel[c.status]), formatRelative(c.updatedAt, intl)]
                                .filter(Boolean)
                                .join(` ${dotSeparator} `)}
                            </span>
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card.Content>
      </Card>

      <Card className="flex min-h-[32rem] flex-col overflow-hidden border border-border lg:h-[calc(100dvh-13rem)]">
        <Card.Header className="flex flex-row items-center gap-2.5 border-b border-border bg-surface/60 px-3 py-2.5 sm:px-4">
          <Button size="sm" variant="ghost" aria-label={intl.formatMessage({ id: "web.components.assistant.assistant_panel.conversations", defaultMessage: "Conversations", description: "Assistant panel: name of the conversation list, used as its accessible name and as the label of the mobile button that opens it; keep it short" })} className="lg:hidden" onPress={() => setListOpen(!listOpen)}>
            <PanelLeft className="h-4 w-4" />
          </Button>
          <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent ring-1 ring-accent/20 sm:flex">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{conv ? conv.title : intl.formatMessage({ id: "web.components.assistant.assistant_panel.new_conversation", defaultMessage: "New conversation", description: "Assistant panel: label of the button that starts a new conversation, also the header title of an unsaved chat; keep it short" })}</div>
            <div className="truncate text-[11px] text-muted">{subtitle}</div>
          </div>
          {conv && (
            <>
              <span className={cn(chipClass, "hidden sm:inline-flex")}>
                <span className={cn("h-1.5 w-1.5 rounded-full", statusTone[conv.status], conv.status === "running" && "animate-pulse")} />
                {intl.formatMessage(statusLabel[conv.status])}
              </span>
              <span className={cn(chipClass, "hidden md:inline-flex")}>{modelLabel(conv.model)} {dotSeparator} {conv.effort}</span>
              <span className={cn(chipClass, "hidden xl:inline-flex")}>{intl.formatMessage({ id: "web.components.assistant.assistant_panel.token_count", defaultMessage: "{tokens} tokens", description: "Assistant panel: chip in the header with the conversation's total token count; {tokens} is the formatted number" }, { tokens: fmt.number(conv.inputTokens + conv.outputTokens) })}</span>
            </>
          )}
        </Card.Header>

        <div className="flex-1 overflow-y-auto px-4 py-5 scrollbar-thin sm:px-6">
          {!selected && (
            <div className="flex h-full flex-col items-center justify-center gap-7 py-6">
              <div className="flex flex-col items-center gap-3 text-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/15 text-accent ring-1 ring-accent/20">
                  <Sparkles className="h-6 w-6" />
                </span>
                <h2 className="text-lg font-semibold">{scoped ? intl.formatMessage({ id: "web.components.assistant.assistant_panel.what_should_i_do_on_server", defaultMessage: "What should I do on {server}?", description: "Assistant panel: heading of the empty chat when the assistant is scoped to one server; {server} is the server name" }, { server: scoped }) : intl.formatMessage({ id: "web.components.assistant.assistant_panel.what_should_i_do", defaultMessage: "What should I do?", description: "Assistant panel: heading of the empty chat when the assistant covers all servers" })}</h2>
                <p className="max-w-xl text-sm leading-relaxed text-muted">
                  {scope.repository
                    ? intl.formatMessage({ id: "web.repositories.assistant.intro", defaultMessage: "I can read and change {repository}'s files, show its Git status and diffs, commit and push — only what your own permissions allow.", description: "Repository assistant: intro under the heading of the empty chat when the assistant is scoped to one repository; {repository} is the repository name" }, { repository: scope.repository })
                    : scope.server
                    ? intl.formatMessage({ id: "web.components.assistant.assistant_panel.i_can_read_and_change_server", defaultMessage: "I can read and change {server}'s files, plugins, players and backups — only what your own permissions allow.", description: "Assistant panel: intro under the heading of the empty chat when the assistant is scoped to one server; {server} is the server name" }, { server: scope.server })
                    : intl.formatMessage({ id: "web.components.assistant.assistant_panel.ask_about_any_server", defaultMessage: "Ask about any server you can access, or about all of them. I act only with your own permissions.", description: "Assistant panel: intro under the heading of the empty chat when the assistant covers all servers" })}
                </p>
              </div>
              <div className="grid w-full max-w-3xl gap-3 sm:grid-cols-3">
                {starters.map((starter) => (
                  <button
                    key={starter.title.id}
                    type="button"
                    onClick={() => setPrompt(intl.formatMessage(starter.prompt))}
                    className="flex flex-col gap-2 rounded-2xl border border-border bg-surface-secondary/50 p-4 text-left transition-colors hover:border-accent/40 hover:bg-accent/5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-accent [&>svg]:h-3.5 [&>svg]:w-3.5">
                      {starter.icon}
                    </span>
                    <span className="text-sm font-medium text-foreground">{intl.formatMessage(starter.title)}</span>
                    <span className="text-xs leading-relaxed text-muted">{intl.formatMessage({ id: "web.components.assistant.assistant_panel.quoted_prompt", defaultMessage: "“{prompt}”", description: "Assistant panel: starter card text that wraps the example prompt in quotation marks; use the target language's own quotation marks around {prompt}, and {prompt} is the example prompt" }, { prompt: intl.formatMessage(starter.prompt) })}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {selected && detail.isLoading && <div className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />{intl.formatMessage({ id: "web.components.assistant.assistant_panel.loading", defaultMessage: "Loading…", description: "Assistant panel: loading text shown in the thread while the selected conversation loads" })}</div>}
          {selected && detail.data && <Thread detail={detail.data} tail={tail} scope={scope} own={own} deciding={decide.isPending} onDecide={(approve) => decide.mutate(approve)} />}
        </div>

        {conv?.error && <p className="mx-4 mb-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{conv.error}</p>}
        {own && conv?.status === "awaiting_approval" && approvals.length > 0 && (
          <div role="alert" className="mx-4 mb-3 space-y-3 rounded-2xl border border-warning/40 bg-warning-soft p-4 text-warning-soft-foreground shadow-sm">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldAlert className="h-4 w-4" />
              {intl.formatMessage({ id: "web.components.assistant.assistant_panel.approve_pending", defaultMessage: "Approve {count, plural, one {this action} other {these actions}}?", description: "Assistant panel: question above the list of actions waiting for approval; {count} is the number of pending actions" }, { count: approvals.length })}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                {approvals.map((p) => (
                  <li key={p.id}>
                    {p.method === LINEAR_METHOD ? (
                      <span className="inline-flex items-center gap-1.5 rounded-lg bg-foreground/10 px-2 py-1 text-xs">
                        <LinearLogo className="h-3.5 w-3.5" />
                        <code className="font-mono">{p.path}</code>
                      </span>
                    ) : (
                      <code className="rounded-lg bg-foreground/10 px-2 py-1 font-mono text-xs">{p.method} {p.path}</code>
                    )}
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" isDisabled={decide.isPending} onPress={() => decide.mutate(false)}><X className="h-4 w-4" />{intl.formatMessage({ id: "web.components.assistant.assistant_panel.decline", defaultMessage: "Decline", description: "Assistant panel: button that rejects the actions waiting for approval; keep it short" })}</Button>
                <Button variant="primary" size="sm" isDisabled={decide.isPending} onPress={() => decide.mutate(true)}><Check className="h-4 w-4" />{intl.formatMessage({ id: "web.components.assistant.assistant_panel.approve", defaultMessage: "Approve", description: "Assistant panel: button that approves the actions waiting for approval; keep it short" })}</Button>
              </div>
            </div>
          </div>
        )}
        {actionError && <div className="mx-4 mb-3"><ErrorBanner err={actionError} /></div>}

        <div className="space-y-2 border-t border-border bg-surface/60 p-3 sm:px-4">
          <QueuedMessages items={queue.items} disabled={submit.isPending || stop.isPending} onSendNow={queue.sendNow} />
          <div className="flex flex-wrap items-center gap-1.5">
            {scoped && <span className={chipClass}>{scope.repository ? <FolderGit2 className="h-3 w-3" /> : <Server className="h-3 w-3" />}{scoped}</span>}
            <span className={chipClass}><Lock className="h-3 w-3" />{intl.formatMessage({ id: "web.components.assistant.assistant_panel.acts_with_your_permissions", defaultMessage: "Acts with your permissions", description: "Assistant panel: chip above the message box reminding that the assistant acts with the user's own permissions; keep it short" })}</span>
            <Select aria-label={modeLabel} selectedKey={mode} isDisabled={!own} onSelectionChange={(key) => setPickedMode(ASSISTANT_MODES.find((option) => option.id === key)?.id)}>
              <Select.Trigger data-chip className={cn(chipClass, "hover:bg-foreground/10", mode === "bypassPermissions" && "bg-danger/10 text-danger", mode === "plan" && "bg-warning-soft text-warning-soft-foreground")}>
                <ShieldCheck className="h-3 w-3" />
                <span>{intl.formatMessage(ASSISTANT_MODES.find((option) => option.id === mode)?.label ?? ASSISTANT_MODES[0].label)}</span>
                <Select.Indicator className="h-3 w-3" />
              </Select.Trigger>
              <Select.Popover className="rounded border border-border">
                <ListBox aria-label={modeLabel}>
                  {ASSISTANT_MODES.map((option) => (
                    <ListBoxItem key={option.id} id={option.id} aria-label={intl.formatMessage(option.label)}>
                      <span className="flex flex-col">
                        <span>{intl.formatMessage(option.label)}</span>
                        <span className="text-xs text-muted">{intl.formatMessage(option.hint)}</span>
                      </span>
                    </ListBoxItem>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <ModelPicker value={model} onChange={setPickedModel} isDisabled={!own} className={chipClass} />
          </div>
          <div className="rounded-2xl border border-border bg-surface p-2 transition-colors focus-within:border-accent/50">
            <AttachmentTray items={attachments.items} onRemove={attachments.remove} />
            <MentionTextArea
              scope={scope}
              linear={!!status.data.linear}
              aria-label={intl.formatMessage({ id: "web.components.assistant.assistant_panel.message_the_assistant", defaultMessage: "Message the assistant", description: "Assistant panel: accessible name of the message box where the user types a prompt" })}
              className="field-sizing-content max-h-40 min-h-[2.5rem] w-full resize-none border-0 bg-transparent px-2 py-1 shadow-none focus:ring-0"
              rows={2}
              value={prompt}
              disabled={!own}
              placeholder={own
                ? scope.repository
                  ? intl.formatMessage({ id: "web.repositories.assistant.placeholder", defaultMessage: "Ask Claude about this repository…", description: "Repository assistant: placeholder of the message box when the assistant is scoped to one repository" })
                  : scope.server
                  ? intl.formatMessage({ id: "web.components.assistant.assistant_panel.placeholder_server_example", defaultMessage: "e.g. \"Set max-players to 50 in server.properties\"", description: "Assistant panel: example prompt shown as the placeholder of the message box when the assistant is scoped to one server; keep the example command as it is" })
                  : intl.formatMessage({ id: "web.components.assistant.assistant_panel.placeholder_lobby_example", defaultMessage: "e.g. \"On lobby, change the MOTD\"", description: "Assistant panel: example prompt shown as the placeholder of the message box when the assistant covers all servers; keep the example as it is" })
                : intl.formatMessage({ id: "web.components.assistant.assistant_panel.read_only_other_user", defaultMessage: "Read-only: this conversation belongs to another user", description: "Assistant panel: placeholder of the message box when the conversation belongs to another user, so it cannot be changed" })}
              onValueChange={setPrompt}
              onEnter={send}
              onPaste={attachments.onPaste}
            />
            <div className="flex items-center gap-2 px-1 pt-1">
              <AttachButton onFiles={attachments.add} disabled={!own} />
              <p className="flex-1 text-[11px] text-muted">{scoped
                ? status.data.linear
                  ? intl.formatMessage({ id: "web.components.assistant.assistant_panel.enter_sends_mentions_linear", defaultMessage: "Enter sends · Shift + Enter adds a line · @ adds a file, a folder or Linear", description: "Assistant panel: hint under the message box of a server's assistant explaining the Enter and Shift + Enter keys and that typing @ picks a server file, a folder or the Linear workspace to give as context" })
                  : intl.formatMessage({ id: "web.components.assistant.assistant_panel.enter_sends_mentions", defaultMessage: "Enter sends · Shift + Enter adds a line · @ adds a file or folder", description: "Assistant panel: hint under the message box of a server's assistant explaining the Enter and Shift + Enter keys and that typing @ picks a server file or folder to give as context" })
                : status.data.linear
                  ? intl.formatMessage({ id: "web.components.assistant.assistant_panel.enter_sends_linear", defaultMessage: "Enter sends · Shift + Enter adds a line · @linear adds Linear", description: "Assistant panel: hint under the message box explaining the Enter and Shift + Enter keys and that typing @linear gives the assistant the Linear workspace or one of its issues" })
                  : intl.formatMessage({ id: "web.components.assistant.assistant_panel.enter_sends_shift_enter_adds_a_line", defaultMessage: "Enter sends · Shift + Enter adds a line", description: "Assistant panel: hint under the message box explaining what the Enter and Shift + Enter keys do" })}</p>
              {running && own && (
                <Button size="sm" variant="outline" aria-label={intl.formatMessage({ id: "web.components.assistant.assistant_panel.stop", defaultMessage: "Stop", description: "Assistant panel: icon button that stops the running reply; keep it short" })} isDisabled={stop.isPending} onPress={interrupt}><Square className="h-4 w-4" /></Button>
              )}
              <Button size="sm" aria-label={intl.formatMessage({ id: "web.components.assistant.assistant_panel.send", defaultMessage: "Send", description: "Assistant panel: icon button that sends the typed message; keep it short" })} isDisabled={!own || !prompt.trim() || (busy && attachments.items.length > 0)} onPress={send}><Send className="h-4 w-4" /></Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

type Turn = { kind: "text"; text: string } | { kind: "tools"; blocks: AssistantBlock[] };

const TOOL_KIND_MESSAGES: Record<string, MessageDescriptor> = defineMessages({
  grep: { id: "web.components.assistant.assistant_panel.tool_grep", defaultMessage: "Grep", description: "Assistant panel: name of a tool call that searches file contents; a tool name, keep it short" },
  glob: { id: "web.components.assistant.assistant_panel.tool_glob", defaultMessage: "Glob", description: "Assistant panel: name of a tool call that finds files by a name pattern; a tool name, keep it short" },
  search: { id: "web.components.assistant.assistant_panel.tool_web_search", defaultMessage: "Web search", description: "Assistant panel: name of a tool call that searches the web; keep it short" },
  fetch: { id: "web.components.assistant.assistant_panel.tool_fetch", defaultMessage: "Fetch", description: "Assistant panel: name of a tool call that reads a web page; keep it short" },
  background: { id: "web.components.assistant.assistant_panel.tool_shell", defaultMessage: "Shell", description: "Assistant panel: name of a tool call that runs a shell command in the background; keep it short" },
  job: { id: "web.components.assistant.assistant_panel.tool_job", defaultMessage: "Job", description: "Assistant panel: name of a tool call that reads the output of a background command; keep it short" },
  stop: { id: "web.components.assistant.assistant_panel.tool_stop", defaultMessage: "Stop", description: "Assistant panel: name of a tool call that stops a background command; keep it short" },
  monitor: { id: "web.components.assistant.assistant_panel.tool_monitor", defaultMessage: "Monitor", description: "Assistant panel: name of a tool call that watches a background process; a tool name, keep it short" },
});

const TOOL_ACTION_MESSAGES: Record<string, MessageDescriptor> = defineMessages({
  grep: { id: "web.components.assistant.assistant_panel.tool_grep_in", defaultMessage: "\"{pattern}\" in", description: "Assistant panel: action of a grep tool call, put before the folder it searches; {pattern} is the text searched for, quoted; keep the word in" },
  glob: { id: "web.components.assistant.assistant_panel.tool_find_files", defaultMessage: "Find files", description: "Assistant panel: action of a glob tool call that finds files by name pattern; keep it short" },
  search: { id: "web.components.assistant.assistant_panel.tool_search", defaultMessage: "Search", description: "Assistant panel: action of a web search tool call; keep it short" },
  fetch: { id: "web.components.assistant.assistant_panel.tool_read_page", defaultMessage: "Read page", description: "Assistant panel: action of a tool call that reads a web page; keep it short" },
  background: { id: "web.components.assistant.assistant_panel.tool_in_background", defaultMessage: "In background", description: "Assistant panel: action of a shell tool call that runs in the background; keep it short" },
  job: { id: "web.components.assistant.assistant_panel.tool_output_of", defaultMessage: "Output of", description: "Assistant panel: action of a tool call that reads the output of a background job; keep it short" },
});

const TOOL_MESSAGES = defineMessages({
  running: { id: "web.components.assistant.assistant_panel.tool_running", defaultMessage: "Running", description: "Assistant panel: badge of a background command that is still running; keep it short" },
  ended: { id: "web.components.assistant.assistant_panel.tool_ended", defaultMessage: "Ended", description: "Assistant panel: badge of a background command whose status is no longer known; keep it short" },
});

function actionText(view: ToolView, intl: ReturnType<typeof useOptionalIntl>): string {
  const descriptor = TOOL_ACTION_MESSAGES[view.kind];
  return descriptor ? intl.formatMessage(descriptor, { pattern: view.action }) : "";
}

function JobBadge({ job }: { job?: JobStatus }) {
  const intl = useOptionalIntl();
  if (job?.state === "exited") {
    const failed = (job.code ?? 0) !== 0;
    return <span className={cn("rounded-full px-2 py-0.5 font-medium", failed ? "bg-danger/10 text-danger" : "bg-success/10 text-success")}>{intl.formatMessage({ id: "web.components.assistant.assistant_panel.tool_exited", defaultMessage: "Exited {code}", description: "Assistant panel: badge of a background command that finished; {code} is its exit code" }, { code: job.code ?? 0 })}</span>;
  }
  if (job?.state === "gone") return <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-muted">{intl.formatMessage(TOOL_MESSAGES.ended)}</span>;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2 py-0.5 font-medium text-accent">
      <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      {intl.formatMessage(TOOL_MESSAGES.running)}
    </span>
  );
}

function turnsOf(message: AssistantMessage): Turn[] {
  const turns: Turn[] = [];
  for (const block of blocksOf(message)) {
    if (block.type === "text" && block.text) {
      turns.push({ kind: "text", text: block.text });
    } else if (block.type === "tool_use" && block.id && block.name !== "todo_write") {
      const last = turns[turns.length - 1];
      if (last?.kind === "tools") last.blocks.push(block);
      else turns.push({ kind: "tools", blocks: [block] });
    }
  }
  return turns;
}

function resultsOf(messages: AssistantMessage[]): Map<string, AssistantBlock> {
  const results = new Map<string, AssistantBlock>();
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (block.type === "tool_result" && block.tool_use_id) results.set(block.tool_use_id, block);
    }
  }
  return results;
}

function jobsOf(messages: AssistantMessage[], results: Map<string, AssistantBlock>): Map<string, JobStatus> {
  const jobs = new Map<string, JobStatus>();
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (block.type !== "tool_use" || block.name !== "shell_output" || !block.id) continue;
      const result = results.get(block.id);
      const status = result ? jobStatus(resultText(result)) : null;
      if (status) jobs.set(String(block.input?.job_id ?? ""), status);
    }
  }
  return jobs;
}

function lastTodoIdOf(messages: AssistantMessage[]): string | undefined {
  return messages
    .filter((message) => !message.parent)
    .flatMap(blocksOf)
    .filter((block) => block.type === "tool_use" && block.name === "todo_write")
    .at(-1)?.id;
}

function Thread({ detail, tail, scope, own, deciding, onDecide }: { detail: AssistantDetail; tail: string; scope: AssistantScope; own: boolean; deciding: boolean; onDecide: (approve: boolean) => void }) {
  const intl = useOptionalIntl();
  const end = useRef<HTMLLIElement>(null);
  const results = resultsOf(detail.messages);
  const jobs = jobsOf(detail.messages, results);
  const children = new Map<string, AssistantMessage[]>();
  for (const message of detail.messages) {
    if (message.parent) children.set(message.parent, [...(children.get(message.parent) ?? []), message]);
  }
  const pending = new Map(detail.pending.map((p) => [p.id, p.method]));
  const running = detail.conversation.status === "running";
  const awaiting = own && detail.conversation.status === "awaiting_approval";
  const todos = latestTodos(detail.messages);
  const lastTodoId = lastTodoIdOf(detail.messages);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [detail.messages.length, tail]);

  const renderTool = (block: AssistantBlock): ReactNode => {
    const result = results.get(block.id ?? "");
    if (block.name === "Task") {
      const steps = (children.get(block.id ?? "") ?? []).flatMap(blocksOf).filter((step) => step.type === "tool_use" && !!step.id);
      return (
        <SubagentCard key={block.id} block={block} result={result} running={running && !result} count={steps.length}>
          {steps.map(renderTool)}
        </SubagentCard>
      );
    }
    if (block.name === "ask_user") {
      return <QuestionCard key={block.id} block={block} result={result} conversationId={detail.conversation.id} interactive={awaiting && pending.get(block.id ?? "") === "ASK"} />;
    }
    if (block.name === "propose_plan") {
      return <PlanCard key={block.id} block={block} result={result} interactive={awaiting && pending.get(block.id ?? "") === "PLAN"} deciding={deciding} onDecide={onDecide} />;
    }
    return <ToolCall key={block.id} block={block} result={result} waiting={pending.has(block.id ?? "")} running={running} jobs={jobs} scope={scope} own={own} />;
  };

  return (
    <ol className="space-y-6">
      {detail.messages.map((message, i) => {
        if (message.parent) return null;
        const turns = turnsOf(message);
        const holdsTodos = !!todos && blocksOf(message).some((block) => block.id === lastTodoId);
        if (turns.length === 0 && !holdsTodos) return null;
        if (message.role === "user") {
          const text = requestOf(turns.filter((turn) => turn.kind === "text").map((turn) => turn.text).join("\n"));
          return text ? (
            <li key={i} className="flex flex-col items-end gap-1.5">
              <MessageAttachments blocks={blocksOf(message)} className="max-w-[85%]" />
              <p className="w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-accent-foreground shadow-sm">{text}</p>
              {linearMentions(text).map((issue) => (
                <span key={issue} className="flex max-w-[85%] items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-xs">
                  <LinearLogo className="h-5 w-5" />
                  <span className="min-w-0">
                    <span className="block font-medium">{issue || intl.formatMessage({ id: "web.components.assistant.assistant_panel.linear_workspace", defaultMessage: "Linear workspace", description: "Assistant panel: card under a user message that mentioned @linear, meaning the whole Linear workspace was given as context; keep it short" })}</span>
                    <span className="block text-[11px] text-muted">{issue
                      ? intl.formatMessage({ id: "web.components.assistant.assistant_panel.linear_issue_hint", defaultMessage: "Linear issue", description: "Assistant panel: second line of the card under a user message that mentioned one Linear issue; keep it short" })
                      : intl.formatMessage({ id: "web.components.assistant.assistant_panel.linear_workspace_hint", defaultMessage: "Issues, projects and cycles", description: "Assistant panel: second line of the Linear workspace card under a user message; lists what the assistant can read; keep it short" })}</span>
                  </span>
                </span>
              ))}
            </li>
          ) : null;
        }
        return (
          <li key={i} className="flex gap-3">
            {assistantAvatar}
            <div className="min-w-0 flex-1 space-y-3 pt-1">
              {turns.map((turn, j) =>
                turn.kind === "text" ? (
                  <Markdown key={j} text={turn.text} />
                ) : (
                  <div key={j} className="flex gap-3">
                    <span className="w-0.5 shrink-0 rounded-full bg-border" />
                    <ul className="min-w-0 flex-1 space-y-1.5">{turn.blocks.map(renderTool)}</ul>
                  </div>
                ),
              )}
              {holdsTodos && todos && <TasksCard todos={todos} />}
            </div>
          </li>
        );
      })}
      {tail && (
        <li className="flex gap-3">
          {assistantAvatar}
          <div className="min-w-0 flex-1 pt-1"><Markdown text={tail} /></div>
        </li>
      )}
      {running && !tail && (
        <li className="flex items-center gap-1.5 pl-11 text-xs text-muted">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" />
          <span className="pl-1.5">{intl.formatMessage({ id: "web.components.assistant.assistant_panel.working", defaultMessage: "Working…", description: "Assistant panel: status text shown in the thread while the assistant is working on a reply and has not streamed text yet" })}</span>
        </li>
      )}
      <li ref={end} aria-hidden="true" />
    </ol>
  );
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

const ToolCall = memo(function ToolCall({ block, result, waiting, running, jobs, scope, own }: { block: AssistantBlock; result?: AssistantBlock; waiting: boolean; running: boolean; jobs: Map<string, JobStatus>; scope: AssistantScope; own: boolean }) {
  const intl = useOptionalIntl();
  const text = result ? resultText(result) : "";
  const tool = linearTool(block);
  const view = toolView(block);
  const jobId = result ? jobIdOf(text) : "";
  const body = tool || "file_path" in (block.input ?? {}) ? block.input : block.input?.body;
  const label = tool
    ? `${tool} ${linearArgument(block)}`.trim()
    : view
      ? `${intl.formatMessage(TOOL_KIND_MESSAGES[view.kind])} ${actionText(view, intl)} ${view.arg}`.trim()
      : callLabel(block);
  const [method, ...rest] = label.split(" ");
  const count = view ? resultCount(block, text) : null;
  const jobScope: AssistantScope = {
    server: str(block.input?.server) || scope.server,
    namespace: str(block.input?.namespace) || scope.namespace,
    cluster: str(block.input?.cluster) || scope.cluster,
  };
  let badge: ReactNode = <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-muted">{intl.formatMessage({ id: "web.components.assistant.assistant_panel.not_run", defaultMessage: "not run", description: "Assistant panel: badge on a tool call that has not produced a result yet; keep it short" })}</span>;
  if (jobId) {
    badge = <JobBadge job={jobs.get(jobId)} />;
  } else if (result && count !== null && !result.is_error) {
    badge = (
      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 font-medium text-success">
        <Check aria-hidden="true" className="h-3 w-3" />
        {view?.kind === "glob"
          ? intl.formatMessage({ id: "web.components.assistant.assistant_panel.tool_files", defaultMessage: "{count, plural, one {# file} other {# files}}", description: "Assistant panel: result badge of a glob tool call; {count} is the number of matching files" }, { count })
          : intl.formatMessage({ id: "web.components.assistant.assistant_panel.tool_matches", defaultMessage: "{count, plural, one {# match} other {# matches}}", description: "Assistant panel: result badge of a grep tool call; {count} is the number of matching lines" }, { count })}
      </span>
    );
  } else if (result) {
    badge = (
      <span className={cn("rounded-full px-2 py-0.5 font-medium", result.is_error ? "bg-danger/10 text-danger" : "bg-success/10 text-success")}>
        {resultStatus(text) || (result.is_error
          ? intl.formatMessage({ id: "web.components.assistant.assistant_panel.failed", defaultMessage: "failed", description: "Assistant panel: badge on a finished tool call that returned an error, used when the result gives no status text; keep it short" })
          : intl.formatMessage({ id: "web.components.assistant.assistant_panel.ok", defaultMessage: "ok", description: "Assistant panel: badge on a finished tool call that succeeded, used when the result gives no status text; keep it short" }))}
      </span>
    );
  } else if (waiting) {
    badge = <span className="rounded-full bg-warning-soft px-2 py-0.5 font-medium text-warning-soft-foreground">{intl.formatMessage({ id: "web.components.assistant.assistant_panel.needs_approval", defaultMessage: "needs approval", description: "Assistant panel: badge on a tool call that waits for the user's approval; keep it short" })}</span>;
  } else if (running) {
    badge = <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" aria-label={intl.formatMessage({ id: "web.components.assistant.assistant_panel.running", defaultMessage: "Running", description: "Assistant panel: screen-reader label of the spinner shown on a tool call that is running; keep it short" })} />;
  }
  return (
    <li>
      <details className="group overflow-hidden rounded-xl border border-border bg-surface-secondary/60 text-xs transition-colors hover:border-border/80">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted transition-transform group-open:rotate-90" />
          {tool ? (
            <>
              <LinearLogo />
              <span aria-hidden="true" className="shrink-0 font-medium text-foreground">{intl.formatMessage({ id: "web.components.assistant.assistant_panel.linear", defaultMessage: "Linear", description: "Assistant panel: name shown on a tool call that went to Linear; a product name, usually left untranslated" })}</span>
              <span aria-hidden="true" className="shrink-0 text-muted">{tool}</span>
              <code aria-hidden="true" className="min-w-0 flex-1 truncate font-mono text-accent">{linearArgument(block)}</code>
            </>
          ) : view ? (
            <>
              <span aria-hidden="true" className="shrink-0 font-medium text-foreground">{intl.formatMessage(TOOL_KIND_MESSAGES[view.kind])}</span>
              {actionText(view, intl) && <span aria-hidden="true" className="shrink-0 text-muted">{actionText(view, intl)}</span>}
              <code aria-hidden="true" className="min-w-0 flex-1 truncate font-mono text-accent">{view.arg}</code>
            </>
          ) : (
            <>
              <span aria-hidden="true" className={cn("shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold", methodTone[method] ?? "bg-foreground/5 text-muted")}>{method}</span>
              <code aria-hidden="true" className="min-w-0 flex-1 truncate font-mono text-muted">{rest.join(" ")}</code>
            </>
          )}
          <span className="sr-only">{label}</span>
          {badge}
        </summary>
        {body !== undefined && (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-border px-3 py-2 font-mono text-[11px] scrollbar-thin">
            {typeof body === "string" ? body : JSON.stringify(body, null, 2)}
          </pre>
        )}
        {result && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-border px-3 py-2 font-mono text-[11px] text-muted scrollbar-thin">{text}</pre>}
      </details>
      {jobId && <div className="mt-1.5"><BackgroundActions scope={jobScope} jobId={jobId} status={jobs.get(jobId)} own={own} /></div>}
    </li>
  );
});
