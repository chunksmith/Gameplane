import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, TextArea } from "@heroui/react";
import { Check, ChevronRight, Loader2, MessageSquarePlus, Send, ShieldAlert, Sparkles, Square, Users, X } from "lucide-react";
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

const serverStarters = ["What is this server's status?", "Show me server.properties", "Which plugins are installed?"];
const fleetStarters = ["List all my servers", "Which servers are offline?", "Show the latest backups"];

export function AssistantPanel({ scope = {} }: { scope?: AssistantScope }) {
  const status = useAssistantStatus();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [prompt, setPrompt] = useState("");
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
  const send = () => {
    const text = prompt.trim();
    if (text && !busy) submit.mutate(text);
  };
  const actionError = submit.error ?? decide.error ?? stop.error;

  return (
    <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <Card className="border border-border bg-surface/60 lg:sticky lg:top-4 lg:self-start">
        <Card.Content className="space-y-2 p-3">
          <Button variant="primary" className="w-full justify-center" onPress={() => setSelected(null)}>
            <MessageSquarePlus className="h-4 w-4" />New conversation
          </Button>
          {can(me, "audit:read") && (
            <Button size="sm" variant={all ? "secondary" : "ghost"} className="w-full justify-center" aria-pressed={all} onPress={() => setAll(!all)}>
              <Users className="h-4 w-4" />All users
            </Button>
          )}
          <ul className="max-h-56 space-y-1 overflow-y-auto scrollbar-thin lg:max-h-[26rem]" aria-label="Conversations">
            {list.data?.length === 0 && <li className="px-2 py-6 text-center text-xs text-muted">No conversations yet</li>}
            {list.data?.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelected(c.id)}
                  aria-current={c.id === selected ? "true" : undefined}
                  className={cn(
                    "w-full rounded-xl border px-3 py-2.5 text-left transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent",
                    c.id === selected
                      ? "border-accent/40 bg-accent/10 shadow-sm"
                      : "border-transparent hover:border-border hover:bg-foreground/5",
                  )}
                >
                  <div className="truncate text-sm font-medium">{c.title}</div>
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusTone[c.status], c.status === "running" && "animate-pulse")} />
                    <span className="truncate">
                      {[all ? c.username : "", all && c.server ? c.server : "", formatRelative(c.updatedAt)].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card.Content>
      </Card>

      <Card className="flex min-h-[32rem] flex-col overflow-hidden border border-border lg:h-[calc(100dvh-13rem)]">
        {conv && (
          <Card.Header className="flex flex-row flex-wrap items-center gap-2 border-b border-border bg-surface/60 px-4 py-3">
            <div className="w-full min-w-0 truncate text-sm font-semibold sm:w-auto sm:flex-1">{conv.title}</div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 text-xs text-muted">
              <span className={cn("h-1.5 w-1.5 rounded-full", statusTone[conv.status], conv.status === "running" && "animate-pulse")} />{statusLabel[conv.status]}
            </span>
            <span className="rounded-full bg-foreground/5 px-2.5 py-1 text-xs text-muted">{modelLabel(conv.model)} · {conv.effort}</span>
            <span className="text-xs text-muted">{(conv.inputTokens + conv.outputTokens).toLocaleString()} tokens</span>
          </Card.Header>
        )}
        <div className="flex-1 overflow-y-auto px-4 py-5 scrollbar-thin sm:px-6">
          {!selected && (
            <div className="flex h-full flex-col items-center justify-center gap-5">
              <EmptyState
                icon={<Sparkles />}
                title="What should I do?"
                hint={scope.server
                  ? `I can read and change ${scope.server}'s files, plugins, players and backups — only what your own permissions allow.`
                  : "Ask about any server you can access, or about all of them. I act only with your own permissions."}
              />
              <div className="flex flex-wrap justify-center gap-2">
                {(scope.server ? serverStarters : fleetStarters).map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => setPrompt(starter)}
                    className="rounded-full border border-border bg-surface px-3.5 py-1.5 text-xs text-muted transition-colors hover:border-accent/40 hover:bg-accent/10 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          )}
          {selected && detail.isLoading && <div className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>}
          {selected && detail.data && <Thread detail={detail.data} />}
        </div>

        {conv?.error && <p className="mx-4 mb-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{conv.error}</p>}
        {own && conv?.status === "awaiting_approval" && detail.data && detail.data.pending.length > 0 && (
          <div role="alert" className="mx-4 mb-3 space-y-3 rounded-2xl border border-warning/40 bg-warning-soft p-4 text-warning-soft-foreground shadow-sm">
            <div className="flex items-center gap-2 text-sm font-medium"><ShieldAlert className="h-4 w-4" />Approve {detail.data.pending.length === 1 ? "this action" : "these actions"}?</div>
            <ul className="space-y-1">
              {detail.data.pending.map((p) => <li key={p.id}><code className="font-mono text-xs">{p.method} {p.path}</code></li>)}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" isDisabled={decide.isPending} onPress={() => decide.mutate(false)}><X className="h-4 w-4" />Decline</Button>
              <Button variant="danger" size="sm" isDisabled={decide.isPending} onPress={() => decide.mutate(true)}><Check className="h-4 w-4" />Approve</Button>
            </div>
          </div>
        )}
        {actionError && <div className="mx-4 mb-3"><ErrorBanner err={actionError} /></div>}

        <div className="border-t border-border bg-surface/60 p-3">
          <div className="flex items-end gap-2">
            <TextArea
              aria-label="Message the assistant"
              className="field-sizing-content max-h-40 min-h-[2.75rem] flex-1 resize-none rounded-2xl"
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
            {running && own ? (
              <Button variant="outline" className="rounded-2xl" isDisabled={stop.isPending} onPress={() => stop.mutate()}><Square className="h-4 w-4" />Stop</Button>
            ) : (
              <Button className="rounded-2xl" isDisabled={!own || busy || !prompt.trim()} onPress={send}><Send className="h-4 w-4" />Send</Button>
            )}
          </div>
          <p className="px-1 pt-2 text-[11px] text-muted">Enter sends · Shift + Enter adds a line</p>
        </div>
      </Card>
    </div>
  );
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
    <ol className="space-y-5">
      {detail.messages.flatMap((message, i) =>
        blocksOf(message).map((block, j) => {
          const key = `${i}-${j}`;
          if (block.type === "text" && block.text) {
            return message.role === "user" ? (
              <li key={key} className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-accent-foreground shadow-sm">{block.text}</li>
            ) : (
              <li key={key} className="flex gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent ring-1 ring-accent/20"><Sparkles className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1 pt-1"><Markdown text={block.text} /></div>
              </li>
            );
          }
          if (block.type === "tool_use" && block.id) {
            return <ToolCall key={key} block={block} result={results.get(block.id)} waiting={pending.has(block.id)} running={running} />;
          }
          return null;
        }),
      )}
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
    <li className="pl-11">
      <details className="group rounded-xl border border-border bg-surface-secondary/60 text-xs transition-colors hover:border-border/80">
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
