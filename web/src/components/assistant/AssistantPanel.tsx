import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, TextArea } from "@heroui/react";
import { Check, Loader2, MessageSquarePlus, Send, ShieldAlert, Sparkles, Square, Users, Wrench, X } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
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
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Card className="border border-border lg:self-start">
        <Card.Content className="space-y-3 p-3">
          <Button variant="outline" className="w-full" onPress={() => setSelected(null)}>
            <MessageSquarePlus className="h-4 w-4" />New conversation
          </Button>
          {can(me, "audit:read") && (
            <Button size="sm" variant={all ? "primary" : "ghost"} className="w-full" aria-pressed={all} onPress={() => setAll(!all)}>
              <Users className="h-4 w-4" />All users
            </Button>
          )}
          <ul className="max-h-[28rem] space-y-1 overflow-y-auto scrollbar-thin" aria-label="Conversations">
            {list.data?.length === 0 && <li className="px-2 py-4 text-center text-xs text-muted">No conversations yet</li>}
            {list.data?.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelected(c.id)}
                  aria-current={c.id === selected ? "true" : undefined}
                  className={cn(
                    "w-full rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent",
                    c.id === selected ? "bg-accent/10" : "hover:bg-foreground/5",
                  )}
                >
                  <div className="truncate text-sm">{c.title}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusTone[c.status])} />
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

      <Card className="flex min-h-[32rem] flex-col border border-border">
        {conv && (
          <Card.Header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1 truncate text-sm font-semibold">{conv.title}</div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 text-xs text-muted">
              <span className={cn("h-1.5 w-1.5 rounded-full", statusTone[conv.status])} />{statusLabel[conv.status]}
            </span>
            <span className="rounded-full bg-foreground/5 px-2.5 py-1 text-xs text-muted">{modelLabel(conv.model)} · {conv.effort}</span>
            <span className="text-xs text-muted">{(conv.inputTokens + conv.outputTokens).toLocaleString()} tokens</span>
          </Card.Header>
        )}
        <div className="flex-1 overflow-y-auto px-4 py-4 scrollbar-thin">
          {!selected && (
            <EmptyState
              icon={<Sparkles />}
              title="What should I do?"
              hint={scope.server
                ? `I can read and change ${scope.server}'s files, plugins, players and backups — only what your own permissions allow.`
                : "Ask about any server you can access, or about all of them. I act only with your own permissions."}
            />
          )}
          {selected && detail.isLoading && <div className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>}
          {selected && detail.data && <Thread detail={detail.data} />}
        </div>

        {conv?.error && <p className="mx-4 mb-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{conv.error}</p>}
        {own && conv?.status === "awaiting_approval" && detail.data && detail.data.pending.length > 0 && (
          <div role="alert" className="mx-4 mb-3 space-y-3 rounded-xl border border-warning/40 bg-warning-soft p-4 text-warning-soft-foreground">
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

        <div className="flex items-end gap-2 border-t border-border p-3">
          <TextArea
            aria-label="Message the assistant"
            className="min-h-[2.75rem] flex-1 resize-none"
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
            <Button variant="outline" isDisabled={stop.isPending} onPress={() => stop.mutate()}><Square className="h-4 w-4" />Stop</Button>
          ) : (
            <Button isDisabled={!own || busy || !prompt.trim()} onPress={send}><Send className="h-4 w-4" />Send</Button>
          )}
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
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [detail.messages.length]);
  return (
    <ol className="space-y-3">
      {detail.messages.flatMap((message, i) =>
        blocksOf(message).map((block, j) => {
          const key = `${i}-${j}`;
          if (block.type === "text" && block.text) {
            return message.role === "user" ? (
              <li key={key} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent/10 px-4 py-2 text-sm">{block.text}</li>
            ) : (
              <li key={key} className="flex gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent"><Sparkles className="h-4 w-4" /></span>
                <div className="min-w-0 whitespace-pre-wrap pt-1 text-sm leading-relaxed">{block.text}</div>
              </li>
            );
          }
          if (block.type === "tool_use" && block.id) {
            return <ToolCall key={key} block={block} result={results.get(block.id)} waiting={pending.has(block.id)} running={running} />;
          }
          return null;
        }),
      )}
      {running && <li className="flex items-center gap-2 pl-11 text-xs text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" />Working…</li>}
      <li ref={end} aria-hidden="true" />
    </ol>
  );
}

function ToolCall({ block, result, waiting, running }: { block: AssistantBlock; result?: AssistantBlock; waiting: boolean; running: boolean }) {
  const text = result ? resultText(result) : "";
  const body = block.input?.body;
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
      <details className="rounded-lg border border-border bg-surface/40 text-xs">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
          <Wrench className="h-3.5 w-3.5 shrink-0 text-muted" />
          <code className="min-w-0 flex-1 truncate font-mono">{callLabel(block)}</code>
          {badge}
        </summary>
        {body !== undefined && (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-border px-3 py-2 font-mono text-[11px]">
            {typeof body === "string" ? body : JSON.stringify(body, null, 2)}
          </pre>
        )}
        {result && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-border px-3 py-2 font-mono text-[11px] text-muted">{text}</pre>}
      </details>
    </li>
  );
}
