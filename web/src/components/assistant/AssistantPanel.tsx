import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Input, TextArea } from "@heroui/react";
import {
  Activity,
  Archive,
  Check,
  ChevronRight,
  FileText,
  Loader2,
  Lock,
  MessageSquarePlus,
  Package,
  PanelLeft,
  Search,
  Send,
  Server,
  ShieldAlert,
  Sparkles,
  Square,
  Users,
  X,
} from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Markdown } from "@/components/assistant/Markdown";
import { can, useMe } from "@/lib/auth";
import { cn, formatRelative } from "@/lib/utils";
import {
  Assistant,
  blocksOf,
  callLabel,
  modelLabel,
  resultStatus,
  resultText,
  scopeQuery,
  useAssistantStatus,
  type AssistantBlock,
  type AssistantConversation,
  type AssistantDetail,
  type AssistantMessage,
  type AssistantScope,
} from "@/lib/assistant";

const statusTone: Record<AssistantConversation["status"], string> = {
  running: "bg-accent",
  awaiting_approval: "bg-warning",
  idle: "bg-success",
  error: "bg-danger",
};

const statusLabel: Record<AssistantConversation["status"], string> = {
  running: "Working",
  awaiting_approval: "Needs approval",
  idle: "Done",
  error: "Stopped",
};

const methodTone: Record<string, string> = {
  GET: "bg-link/10 text-link",
  POST: "bg-success/10 text-success",
  PUT: "bg-warning/10 text-warning",
  PATCH: "bg-warning/10 text-warning",
  DELETE: "bg-danger/10 text-danger",
};

interface Starter {
  icon: ReactNode;
  title: string;
  prompt: string;
}

const serverStarters: Starter[] = [
  { icon: <Activity />, title: "Check health", prompt: "What is this server's status?" },
  { icon: <FileText />, title: "Read the config", prompt: "Show me server.properties" },
  { icon: <Package />, title: "Audit plugins", prompt: "Which plugins are installed?" },
];

const fleetStarters: Starter[] = [
  { icon: <Server />, title: "List servers", prompt: "List all my servers" },
  { icon: <Activity />, title: "Find outages", prompt: "Which servers are offline?" },
  { icon: <Archive />, title: "Check backups", prompt: "Show the latest backups" },
];

const DAY_GROUPS = ["Today", "Yesterday", "Earlier"] as const;

type DayGroup = (typeof DAY_GROUPS)[number];

function dayGroup(iso: string): DayGroup {
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(new Date(iso))) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return "Earlier";
}

const chipClass = "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 text-xs text-muted";

export function AssistantPanel({ scope = {} }: { scope?: AssistantScope }) {
  const status = useAssistantStatus();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [search, setSearch] = useState("");
  const [listOpen, setListOpen] = useState(false);
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

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = (list.data ?? []).filter((c) => !needle || c.title.toLowerCase().includes(needle));
    return DAY_GROUPS.map((label) => ({ label, items: matches.filter((c) => dayGroup(c.updatedAt) === label) })).filter(
      (group) => group.items.length > 0,
    );
  }, [list.data, search]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["ai"] });
  const submit = useMutation({
    mutationFn: (text: string) => (selected ? Assistant.send(selected, text) : Assistant.create(text, scope)),
    onSuccess: (conv) => {
      setPrompt("");
      setSelected(conv.id);
      refresh();
    },
  });
  const decide = useMutation({ mutationFn: (approve: boolean) => Assistant.decide(selected ?? "", approve), onSuccess: refresh });
  const stop = useMutation({ mutationFn: () => Assistant.cancel(selected ?? ""), onSuccess: refresh });

  if (status.isLoading) {
    return <div className="flex items-center gap-2 p-6 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading assistant…</div>;
  }
  if (!status.data?.enabled) {
    return <EmptyState icon={<Sparkles />} title="The AI assistant is turned off" hint="An admin can turn it on under Admin settings → AI assistant." />;
  }
  if (!status.data.configured) {
    return <EmptyState icon={<Sparkles />} title="No Claude API key yet" hint="An admin needs to add a Claude API key under Admin settings → AI assistant." />;
  }

  const conv = selected ? detail.data?.conversation : undefined;
  const own = !conv || conv.userId === me?.id;
  const running = conv?.status === "running";
  const busy = running || conv?.status === "awaiting_approval" || submit.isPending;
  const starters = scope.server ? serverStarters : fleetStarters;
  const pending = detail.data?.pending ?? [];
  const open = (id: string | null) => {
    setSelected(id);
    setListOpen(false);
  };
  const send = () => {
    const text = prompt.trim();
    if (text && !busy) submit.mutate(text);
  };
  const actionError = submit.error ?? decide.error ?? stop.error;
  const subtitle = conv
    ? [all && conv.username, conv.server || "All servers", conv.namespace].filter(Boolean).join(" · ")
    : scope.server
      ? [scope.server, scope.namespace].filter(Boolean).join(" · ")
      : "All servers you can access";

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card className={cn("border border-border bg-surface/60 lg:sticky lg:top-4 lg:self-start", !listOpen && "hidden lg:block")}>
        <Card.Content className="space-y-2.5 p-3">
          <Button variant="primary" className="w-full justify-center" onPress={() => open(null)}>
            <MessageSquarePlus className="h-4 w-4" />New conversation
          </Button>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations…"
              aria-label="Search conversations"
              className="w-full pl-8"
            />
          </div>
          {can(me, "audit:read") && (
            <div className="flex gap-1.5">
              <Button size="sm" variant={all ? "ghost" : "secondary"} aria-pressed={!all} onPress={() => setAll(false)}>Mine</Button>
              <Button size="sm" variant={all ? "secondary" : "ghost"} aria-pressed={all} onPress={() => setAll(true)}>
                <Users className="h-3.5 w-3.5" />All users
              </Button>
            </div>
          )}
          <ul className="max-h-64 space-y-0.5 overflow-y-auto scrollbar-thin lg:max-h-[26rem]" aria-label="Conversations">
            {groups.length === 0 && (
              <li className="px-2 py-6 text-center text-xs text-muted">{search.trim() ? "No matching conversations" : "No conversations yet"}</li>
            )}
            {groups.map((group) => (
              <li key={group.label}>
                <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted first:pt-1">{group.label}</p>
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
                              {[all ? c.username : "", all && c.server ? c.server : "", statusLabel[c.status], formatRelative(c.updatedAt)]
                                .filter(Boolean)
                                .join(" · ")}
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
          <Button size="sm" variant="ghost" aria-label="Conversations" className="lg:hidden" onPress={() => setListOpen(!listOpen)}>
            <PanelLeft className="h-4 w-4" />
          </Button>
          <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent ring-1 ring-accent/20 sm:flex">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{conv ? conv.title : "New conversation"}</div>
            <div className="truncate text-[11px] text-muted">{subtitle}</div>
          </div>
          {conv && (
            <>
              <span className={cn(chipClass, "hidden sm:inline-flex")}>
                <span className={cn("h-1.5 w-1.5 rounded-full", statusTone[conv.status], conv.status === "running" && "animate-pulse")} />
                {statusLabel[conv.status]}
              </span>
              <span className={cn(chipClass, "hidden md:inline-flex")}>{modelLabel(conv.model)} · {conv.effort}</span>
              <span className={cn(chipClass, "hidden xl:inline-flex")}>{(conv.inputTokens + conv.outputTokens).toLocaleString()} tokens</span>
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
                <h2 className="text-lg font-semibold">{scope.server ? `What should I do on ${scope.server}?` : "What should I do?"}</h2>
                <p className="max-w-xl text-sm leading-relaxed text-muted">
                  {scope.server
                    ? `I can read and change ${scope.server}'s files, plugins, players and backups — only what your own permissions allow.`
                    : "Ask about any server you can access, or about all of them. I act only with your own permissions."}
                </p>
              </div>
              <div className="grid w-full max-w-3xl gap-3 sm:grid-cols-3">
                {starters.map((starter) => (
                  <button
                    key={starter.title}
                    type="button"
                    onClick={() => setPrompt(starter.prompt)}
                    className="flex flex-col gap-2 rounded-2xl border border-border bg-surface-secondary/50 p-4 text-left transition-colors hover:border-accent/40 hover:bg-accent/5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-accent [&>svg]:h-3.5 [&>svg]:w-3.5">
                      {starter.icon}
                    </span>
                    <span className="text-sm font-medium text-foreground">{starter.title}</span>
                    <span className="text-xs leading-relaxed text-muted">“{starter.prompt}”</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {selected && detail.isLoading && <div className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>}
          {selected && detail.data && <Thread detail={detail.data} />}
        </div>

        {conv?.error && <p className="mx-4 mb-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{conv.error}</p>}
        {own && conv?.status === "awaiting_approval" && pending.length > 0 && (
          <div role="alert" className="mx-4 mb-3 space-y-3 rounded-2xl border border-warning/40 bg-warning-soft p-4 text-warning-soft-foreground shadow-sm">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldAlert className="h-4 w-4" />
              {`Approve ${pending.length === 1 ? "this action" : "these actions"}?`}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                {pending.map((p) => (
                  <li key={p.id}>
                    <code className="rounded-lg bg-foreground/10 px-2 py-1 font-mono text-xs">{p.method} {p.path}</code>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" isDisabled={decide.isPending} onPress={() => decide.mutate(false)}><X className="h-4 w-4" />Decline</Button>
                <Button variant="primary" size="sm" isDisabled={decide.isPending} onPress={() => decide.mutate(true)}><Check className="h-4 w-4" />Approve</Button>
              </div>
            </div>
          </div>
        )}
        {actionError && <div className="mx-4 mb-3"><ErrorBanner err={actionError} /></div>}

        <div className="space-y-2 border-t border-border bg-surface/60 p-3 sm:px-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {scope.server && <span className={chipClass}><Server className="h-3 w-3" />{scope.server}</span>}
            <span className={chipClass}><Lock className="h-3 w-3" />Acts with your permissions</span>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-2 transition-colors focus-within:border-accent/50">
            <TextArea
              aria-label="Message the assistant"
              className="field-sizing-content max-h-40 min-h-[2.5rem] w-full resize-none border-0 bg-transparent px-2 py-1 shadow-none focus:ring-0"
              rows={2}
              value={prompt}
              disabled={!own}
              placeholder={own
                ? scope.server ? `e.g. "Set max-players to 50 in server.properties"` : `e.g. "On lobby, change the MOTD"`
                : "Read-only: this conversation belongs to another user"}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="flex items-center gap-2 px-1 pt-1">
              <p className="flex-1 text-[11px] text-muted">Enter sends · Shift + Enter adds a line</p>
              {running && own ? (
                <Button size="sm" variant="outline" aria-label="Stop" isDisabled={stop.isPending} onPress={() => stop.mutate()}><Square className="h-4 w-4" /></Button>
              ) : (
                <Button size="sm" aria-label="Send" isDisabled={!own || busy || !prompt.trim()} onPress={send}><Send className="h-4 w-4" /></Button>
              )}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

type Turn = { kind: "text"; text: string } | { kind: "tools"; blocks: AssistantBlock[] };

function turnsOf(message: AssistantMessage): Turn[] {
  const turns: Turn[] = [];
  for (const block of blocksOf(message)) {
    if (block.type === "text" && block.text) {
      turns.push({ kind: "text", text: block.text });
    } else if (block.type === "tool_use" && block.id) {
      const last = turns[turns.length - 1];
      if (last?.kind === "tools") last.blocks.push(block);
      else turns.push({ kind: "tools", blocks: [block] });
    }
  }
  return turns;
}

function Thread({ detail }: { detail: AssistantDetail }) {
  const end = useRef<HTMLLIElement>(null);
  const results = new Map<string, AssistantBlock>();
  for (const message of detail.messages) {
    for (const block of blocksOf(message)) {
      if (block.type === "tool_result" && block.tool_use_id) results.set(block.tool_use_id, block);
    }
  }
  const pending = new Set(detail.pending.map((p) => p.id));
  const running = detail.conversation.status === "running";
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [detail.messages.length]);

  return (
    <ol className="space-y-6">
      {detail.messages.map((message, i) => {
        const turns = turnsOf(message);
        if (turns.length === 0) return null;
        if (message.role === "user") {
          const text = turns.filter((turn) => turn.kind === "text").map((turn) => turn.text).join("\n");
          return text ? (
            <li key={i} className="flex justify-end">
              <p className="w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-accent-foreground shadow-sm">{text}</p>
            </li>
          ) : null;
        }
        return (
          <li key={i} className="flex gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent ring-1 ring-accent/20"><Sparkles className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1 space-y-3 pt-1">
              {turns.map((turn, j) =>
                turn.kind === "text" ? (
                  <Markdown key={j} text={turn.text} />
                ) : (
                  <div key={j} className="flex gap-3">
                    <span className="w-0.5 shrink-0 rounded-full bg-border" />
                    <ul className="min-w-0 flex-1 space-y-1.5">
                      {turn.blocks.map((block) => (
                        <ToolCall key={block.id} block={block} result={results.get(block.id ?? "")} waiting={pending.has(block.id ?? "")} running={running} />
                      ))}
                    </ul>
                  </div>
                ),
              )}
            </div>
          </li>
        );
      })}
      {running && (
        <li className="flex items-center gap-1.5 pl-11 text-xs text-muted">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" />
          <span className="pl-1.5">Working…</span>
        </li>
      )}
      <li ref={end} aria-hidden="true" />
    </ol>
  );
}

function ToolCall({ block, result, waiting, running }: { block: AssistantBlock; result?: AssistantBlock; waiting: boolean; running: boolean }) {
  const text = result ? resultText(result) : "";
  const body = block.input?.body;
  const label = callLabel(block);
  const [method, ...rest] = label.split(" ");
  let badge = <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-muted">not run</span>;
  if (result) {
    badge = (
      <span className={cn("rounded-full px-2 py-0.5 font-medium", result.is_error ? "bg-danger/10 text-danger" : "bg-success/10 text-success")}>
        {resultStatus(text) || (result.is_error ? "failed" : "ok")}
      </span>
    );
  } else if (waiting) {
    badge = <span className="rounded-full bg-warning-soft px-2 py-0.5 font-medium text-warning-soft-foreground">needs approval</span>;
  } else if (running) {
    badge = <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" aria-label="Running" />;
  }
  return (
    <li>
      <details className="group overflow-hidden rounded-xl border border-border bg-surface-secondary/60 text-xs transition-colors hover:border-border/80">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted transition-transform group-open:rotate-90" />
          <span aria-hidden="true" className={cn("shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold", methodTone[method] ?? "bg-foreground/5 text-muted")}>{method}</span>
          <code aria-hidden="true" className="min-w-0 flex-1 truncate font-mono text-muted">{rest.join(" ")}</code>
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
    </li>
  );
}
