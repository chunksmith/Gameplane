import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Button, ListBox, ListBoxItem, Select } from "@heroui/react";
import { DiffEditor } from "@monaco-editor/react";
import { Check, Loader2, Plus, Send, ShieldCheck, Sparkles, Square, X } from "lucide-react";
import { defineMessages } from "react-intl";

import { Markdown } from "@/components/assistant/Markdown";
import { MentionTextArea, mentionContext } from "@/components/assistant/Mentions";
import { ModelPicker } from "@/components/assistant/ModelPicker";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import {
  ASSISTANT_MODES,
  Assistant,
  blocksOf,
  callLabel,
  requestOf,
  useAssistantStatus,
  useAssistantStream,
  withContextBlock,
  type AssistantMessage,
  type AssistantMode,
  type AssistantPick,
  type AssistantScope,
} from "@/lib/assistant";
import { useOptionalIntl } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

const FENCE = /```[^\n]*\n([\s\S]*?)```/g;

const MESSAGES = defineMessages({
  panel: { id: "web.routes.tabs.file_assistant.panel", defaultMessage: "Claude chat", description: "Files tab: accessible label of the Claude chat panel shown beside the file editor; not shown as text" },
  title: { id: "web.routes.tabs.file_assistant.title", defaultMessage: "Claude", description: "Files tab: title in the header of the Claude chat panel beside the file editor; keep it short" },
  close: { id: "web.routes.tabs.file_assistant.close", defaultMessage: "Close chat", description: "Files tab: icon-only button that closes the Claude chat panel beside the file editor; read by screen readers; keep it short" },
  unavailable: { id: "web.routes.tabs.file_assistant.unavailable", defaultMessage: "The AI assistant is not set up. An admin can turn it on under Admin settings → AI assistant.", description: "Files tab: text in the Claude chat panel when the AI assistant is turned off or has no API key" },
  working: { id: "web.routes.tabs.file_assistant.working", defaultMessage: "Working…", description: "Files tab: status in the Claude chat panel while Claude is working on a reply" },
  placeholder: { id: "web.routes.tabs.file_assistant.placeholder", defaultMessage: "Ask Claude about this file…", description: "Files tab: placeholder of the message box in the Claude chat panel beside the file editor" },
  placeholder_folder: { id: "web.routes.tabs.file_assistant.placeholder_folder", defaultMessage: "Ask Claude… type @ to add a file or folder", description: "Files tab: placeholder of the message box in the Claude chat panel opened from a folder, with no file as context; typing @ picks a file or folder to add" },
  empty_folder: { id: "web.routes.tabs.file_assistant.empty_folder", defaultMessage: "Ask Claude anything about this server. Type @ to add a file or folder as context.", description: "Files tab: hint in the empty Claude chat panel opened from a folder, with no file as context" },
  message: { id: "web.routes.tabs.file_assistant.message", defaultMessage: "Message Claude", description: "Files tab: accessible name of the message box in the Claude chat panel; keep it short" },
  mode: { id: "web.routes.tabs.file_assistant.mode", defaultMessage: "Permission mode", description: "Files tab: accessible name of the dropdown in the Claude chat panel that picks how Claude may change files; keep it short" },
  send: { id: "web.routes.tabs.file_assistant.send", defaultMessage: "Send", description: "Files tab: button in the Claude chat panel that sends the typed message; keep it short" },
  stop: { id: "web.routes.tabs.file_assistant.stop", defaultMessage: "Stop", description: "Files tab: icon-only button in the Claude chat panel that stops the running reply; keep it short" },
  apply: { id: "web.routes.tabs.file_assistant.apply", defaultMessage: "Apply to editor", description: "Files tab: button under Claude's suggested change that puts it into the file editor; keep it short" },
  discard: { id: "web.routes.tabs.file_assistant.discard", defaultMessage: "Discard", description: "Files tab: button under Claude's suggested change that hides it without changing the file; keep it short" },
  approve: { id: "web.routes.tabs.file_assistant.approve", defaultMessage: "Approve", description: "Files tab: button in the Claude chat panel that approves the waiting actions; keep it short" },
  decline: { id: "web.routes.tabs.file_assistant.decline", defaultMessage: "Decline", description: "Files tab: button in the Claude chat panel that rejects the waiting actions; keep it short" },
  chats: { id: "web.routes.tabs.file_assistant.chats", defaultMessage: "Claude chats", description: "Files tab: accessible label of the row of tabs above the Claude chat panel, one tab per chat; not shown as text" },
  new_chat: { id: "web.routes.tabs.file_assistant.new_chat", defaultMessage: "New chat", description: "Files tab: title of a Claude chat tab before its first message, and accessible label of the + button that opens a new chat tab; keep it short" },
});

interface ChatTab {
  key: number;
  id: string | null;
}

interface ChatTabs {
  tabs: ChatTab[];
  active: number;
}

const FRESH_TABS: ChatTabs = { tabs: [{ key: 0, id: null }], active: 0 };
const openChats = new WeakMap<QueryClient, Map<string, ChatTabs>>();

interface OpenFile {
  path: string;
  language: string;
  content: string;
  canControl: boolean;
  onApply: (next: string) => void;
  onSaved: () => void;
}

export function FileAssistant({ scope, file, onClose }: { scope: AssistantScope; file?: OpenFile; onClose: () => void }) {
  const intl = useOptionalIntl();
  const storeKey = [scope.cluster, scope.namespace, scope.server].join("/");
  const qc = useQueryClient();
  const [chats, setChats] = useState(() => openChats.get(qc)?.get(storeKey) ?? FRESH_TABS);
  const current = chats.tabs.find((tab) => tab.key === chats.active) ?? chats.tabs[0];

  useEffect(() => void openChats.set(qc, (openChats.get(qc) ?? new Map<string, ChatTabs>()).set(storeKey, chats)), [qc, storeKey, chats]);

  const add = () => {
    const key = Math.max(...chats.tabs.map((tab) => tab.key)) + 1;
    setChats({ tabs: [...chats.tabs, { key, id: null }], active: key });
  };
  const remove = (key: number) => {
    const index = chats.tabs.findIndex((tab) => tab.key === key);
    const rest = chats.tabs.filter((tab) => tab.key !== key);
    if (rest.length === 0) {
      setChats(FRESH_TABS);
      onClose();
      return;
    }
    setChats({ tabs: rest, active: key === chats.active ? rest[Math.min(index, rest.length - 1)].key : chats.active });
  };
  const start = (id: string) => setChats((state) => ({ ...state, tabs: state.tabs.map((tab) => (tab.key === current.key ? { ...tab, id } : tab)) }));

  return (
    <div className="absolute inset-0 flex flex-col gap-2">
      <div role="tablist" aria-label={intl.formatMessage(MESSAGES.chats)} className="flex shrink-0 items-center gap-1 overflow-x-auto rounded-lg border border-border bg-surface p-1 scrollbar-thin">
        {chats.tabs.map((tab) => (
          <ChatTabButton key={tab.key} id={tab.id} active={tab.key === current.key} onSelect={() => setChats({ ...chats, active: tab.key })} onClose={() => remove(tab.key)} />
        ))}
        <Button isIconOnly size="sm" variant="ghost" aria-label={intl.formatMessage(MESSAGES.new_chat)} onPress={add}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative flex-1">
        <ChatPanel key={current.key} id={current.id} onStarted={start} scope={scope} file={file} onClose={onClose} />
      </div>
    </div>
  );
}

function ChatTabButton({ id, active, onSelect, onClose }: { id: string | null; active: boolean; onSelect: () => void; onClose: () => void }) {
  const intl = useOptionalIntl();
  const detail = useQuery({
    queryKey: ["ai", "conversation", id],
    queryFn: () => Assistant.get(id ?? ""),
    enabled: !!id,
    refetchInterval: (query) => (query.state.data?.conversation.status === "running" ? 1500 : false),
  });
  const conv = detail.data?.conversation;
  const title = conv?.title || intl.formatMessage(MESSAGES.new_chat);
  const busy = !active && (conv?.status === "running" || conv?.status === "awaiting_approval");
  return (
    <div className={cn("flex max-w-48 shrink-0 items-center gap-1 rounded-md py-1 pl-2.5 pr-1 text-xs font-medium", active ? "bg-default text-foreground" : "text-muted hover:bg-foreground/5")}>
      <button type="button" role="tab" aria-selected={active} onClick={onSelect} className="flex min-w-0 items-center gap-1.5 focus-visible:outline-none">
        {busy && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
        <span className="truncate">{title}</span>
      </button>
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "web.routes.tabs.file_assistant.close_chat_tab", defaultMessage: "Close {title}", description: "Files tab: accessible label of the x button on a Claude chat tab that closes that chat; {title} is the chat title; not shown as text" }, { title })}
        onClick={onClose}
        className="rounded p-0.5 text-muted hover:bg-foreground/10 hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function ChatPanel({ id, onStarted, scope, file, onClose }: { id: string | null; onStarted: (id: string) => void; scope: AssistantScope; file?: OpenFile; onClose: () => void }) {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const status = useAssistantStatus();
  const [prompt, setPrompt] = useState("");
  const [pickedMode, setPickedMode] = useState<AssistantMode>();
  const [pickedModel, setPickedModel] = useState<AssistantPick>();
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set());
  const end = useRef<HTMLLIElement>(null);
  const wasRunning = useRef(false);
  const ready = !!status.data?.enabled && status.data.configured;
  const fileName = file?.path.split("/").pop() ?? "";

  const detail = useQuery({
    queryKey: ["ai", "conversation", id],
    queryFn: () => Assistant.get(id ?? ""),
    enabled: ready && !!id,
    refetchInterval: (query) => (query.state.data?.conversation.status === "running" ? 1500 : false),
  });
  const conv = detail.data?.conversation;
  const running = conv?.status === "running";
  const tail = useAssistantStream(id, running, () => qc.invalidateQueries({ queryKey: ["ai", "conversation", id] }));
  const mode = pickedMode ?? conv?.mode ?? status.data?.defaultMode ?? "default";
  const model = pickedModel ?? (conv ? { model: conv.model, effort: conv.effort } : { model: status.data?.defaultModel ?? "", effort: status.data?.defaultEffort ?? "" });
  const onSaved = file?.onSaved;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["ai"] });

  const submit = useMutation({
    mutationFn: async (text: string) => {
      const body = withContextBlock(text, file ? fileContext(file.path, file.content, mode) : "", await mentionContext(scope, text));
      return id ? Assistant.send(id, body, mode, pickedModel) : Assistant.create(body, scope, mode, pickedModel);
    },
    onSuccess: (next) => {
      setPrompt("");
      onStarted(next.id);
      refresh();
    },
  });
  const decide = useMutation({ mutationFn: (approve: boolean) => Assistant.decide(id ?? "", approve), onSuccess: refresh });
  const stop = useMutation({ mutationFn: () => Assistant.cancel(id ?? ""), onSuccess: refresh });

  useEffect(() => {
    if (wasRunning.current && !running && conv?.mode === "bypassPermissions") onSaved?.();
    wasRunning.current = running;
  }, [running, conv?.mode, onSaved]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [detail.data?.messages.length, tail]);

  const busy = running || conv?.status === "awaiting_approval" || submit.isPending;
  const send = () => {
    const text = prompt.trim();
    if (text && !busy) submit.mutate(text);
  };
  const actionError = submit.error ?? decide.error ?? stop.error;

  return (
    <section aria-label={intl.formatMessage(MESSAGES.panel)} className="absolute inset-0 flex flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <Sparkles className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-sm font-medium">{intl.formatMessage(MESSAGES.title)}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{file && intl.formatMessage({ id: "web.routes.tabs.file_assistant.context", defaultMessage: "Context: {file}", description: "Files tab: muted text in the Claude chat header naming the file Claude sees; {file} is the file name" }, { file: fileName })}</span>
        <Button isIconOnly size="sm" variant="ghost" aria-label={intl.formatMessage(MESSAGES.close)} onPress={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>

      <ol className="flex-1 space-y-4 overflow-y-auto bg-background p-4 scrollbar-thin">
        {status.isLoading && <li><Loader2 className="h-4 w-4 animate-spin text-muted" /></li>}
        {!status.isLoading && !ready && <li className="text-sm text-muted">{intl.formatMessage(MESSAGES.unavailable)}</li>}
        {ready && !id && <li className="text-sm text-muted">{file ? intl.formatMessage({ id: "web.routes.tabs.file_assistant.empty", defaultMessage: "Ask Claude to explain or change {file}.", description: "Files tab: hint in the empty Claude chat panel beside the file editor; {file} is the file name" }, { file: fileName }) : intl.formatMessage(MESSAGES.empty_folder)}</li>}
        {detail.data?.messages.map((message, index) => (
          <ChatMessage
            key={index}
            message={message}
            file={file}
            dismissed={dismissed.has(index)}
            onDismiss={() => setDismissed((current) => new Set(current).add(index))}
          />
        ))}
        {tail && <li><Markdown text={tail} /></li>}
        {running && !tail && (
          <li className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {intl.formatMessage(MESSAGES.working)}
          </li>
        )}
        {conv?.error && <li className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{conv.error}</li>}
        <li ref={end} aria-hidden="true" />
      </ol>

      {conv?.status === "awaiting_approval" && (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-t border-border bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground">
          <span className="min-w-0 flex-1">{intl.formatMessage({ id: "web.routes.tabs.file_assistant.approve_question", defaultMessage: "Claude wants to run {count, plural, one {an action} other {# actions}} that need your approval.", description: "Files tab: text in the Claude chat panel when actions wait for approval; {count} is the number of actions" }, { count: detail.data?.pending.length ?? 1 })}</span>
          <Button size="sm" variant="ghost" isDisabled={decide.isPending} onPress={() => decide.mutate(false)}>{intl.formatMessage(MESSAGES.decline)}</Button>
          <Button size="sm" variant="primary" isDisabled={decide.isPending} onPress={() => decide.mutate(true)}>{intl.formatMessage(MESSAGES.approve)}</Button>
        </div>
      )}
      {actionError && <div className="px-3 pt-2"><ErrorBanner err={actionError} /></div>}

      <div className="border-t border-border p-3">
        <div className="rounded-xl border border-border bg-surface p-2 transition-colors focus-within:border-primary/50">
          <MentionTextArea
            scope={scope}
            aria-label={intl.formatMessage(MESSAGES.message)}
            className="field-sizing-content max-h-32 min-h-[2.5rem] w-full resize-none border-0 bg-transparent px-2 py-1 shadow-none focus:ring-0"
            rows={2}
            value={prompt}
            disabled={!ready}
            placeholder={intl.formatMessage(file ? MESSAGES.placeholder : MESSAGES.placeholder_folder)}
            onValueChange={setPrompt}
            onEnter={send}
          />
          <div className="flex items-center justify-between gap-2 px-1 pt-1">
            <Select aria-label={intl.formatMessage(MESSAGES.mode)} selectedKey={mode} isDisabled={!ready} onSelectionChange={(key) => setPickedMode(ASSISTANT_MODES.find((option) => option.id === key)?.id)}>
              <Select.Trigger data-chip className={cn("inline-flex items-center gap-1.5 rounded-md bg-foreground/5 px-2 py-1 text-xs text-muted hover:bg-foreground/10", mode === "bypassPermissions" && "bg-danger/10 text-danger")}>
                <ShieldCheck className="h-3 w-3" />
                <Select.Value />
                <Select.Indicator className="h-3 w-3" />
              </Select.Trigger>
              <Select.Popover className="rounded border border-border">
                <ListBox aria-label={intl.formatMessage(MESSAGES.mode)}>
                  {ASSISTANT_MODES.map((option) => (
                    <ListBoxItem key={option.id} id={option.id}>{intl.formatMessage(option.label)}</ListBoxItem>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <ModelPicker value={model} onChange={setPickedModel} isDisabled={!ready} className="mr-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs" />
            {running ? (
              <Button isIconOnly size="sm" variant="outline" aria-label={intl.formatMessage(MESSAGES.stop)} isDisabled={stop.isPending} onPress={() => stop.mutate()}>
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button size="sm" variant="primary" isDisabled={!ready || busy || !prompt.trim()} onPress={send}>
                <Send className="h-3.5 w-3.5" /> {intl.formatMessage(MESSAGES.send)}
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

interface ChatMessageProps {
  message: AssistantMessage;
  file?: OpenFile;
  dismissed: boolean;
  onDismiss: () => void;
}

function ChatMessage({ message, file, dismissed, onDismiss }: ChatMessageProps) {
  const intl = useOptionalIntl();
  const blocks = blocksOf(message);
  const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
  if (message.role === "user") {
    const request = requestOf(text);
    if (!request) return null;
    return (
      <li className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-primary/10 px-3 py-2 text-sm text-primary">{request}</p>
      </li>
    );
  }
  const suggestion = file && [...text.matchAll(FENCE)].at(-1)?.[1];
  const calls = blocks.filter((block) => block.type === "tool_use");
  const prose = suggestion === undefined ? text : text.replace(FENCE, "").trim();
  return (
    <li className="space-y-2.5">
      {prose && <Markdown text={prose} />}
      {calls.map((block) => (
        <code key={block.id} className="block truncate rounded-md bg-foreground/5 px-2 py-1 font-mono text-[11px] text-muted">{callLabel(block)}</code>
      ))}
      {file && suggestion !== undefined && suggestion !== file.content && !dismissed && (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <div className="border-b border-border px-3 py-2 font-mono text-xs font-medium">{file.path.split("/").pop()}</div>
          <div className="h-56">
            <DiffEditor
              original={file.content}
              modified={suggestion}
              language={file.language}
              theme="vs-dark"
              keepCurrentOriginalModel
              keepCurrentModifiedModel
              options={{
                readOnly: true,
                renderSideBySide: false,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                renderOverviewRuler: false,
                hideUnchangedRegions: { enabled: true },
                fontFamily: "JetBrains Mono",
              }}
            />
          </div>
          <div className="flex gap-2 border-t border-border p-2">
            <Button size="sm" variant="primary" isDisabled={!file.canControl} onPress={() => file.onApply(suggestion)}>
              <Check className="h-3.5 w-3.5" /> {intl.formatMessage(MESSAGES.apply)}
            </Button>
            <Button size="sm" variant="ghost" onPress={onDismiss}>{intl.formatMessage(MESSAGES.discard)}</Button>
          </div>
        </div>
      )}
    </li>
  );
}

function fileContext(path: string, content: string, mode: AssistantMode) {
  const rule =
    mode === "bypassPermissions"
      ? `Save your changes to ${path} yourself through the files API.`
      : `Do not write, upload or delete any file. Reply with a short explanation and the complete updated ${path} in one fenced code block.`;
  return `The user is editing ${path} in the Gameplane file editor. ${rule}\nCurrent content:\n\`\`\`\n${content}\n\`\`\``;
}
