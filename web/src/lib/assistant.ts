import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { defineMessages, type MessageDescriptor } from "react-intl";

export const ASSISTANT_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
];

export const ASSISTANT_EFFORTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
];

const PICK_MESSAGES = defineMessages({
  opus: { id: "web.lib.assistant.pick_opus", defaultMessage: "Most capable · {effort} effort", description: "Assistant model picker: line under Opus in the model menu; {effort} is the fixed effort level such as medium or high; keep it short" },
  sonnet: { id: "web.lib.assistant.pick_sonnet", defaultMessage: "Balanced · {effort} effort", description: "Assistant model picker: line under Sonnet in the model menu; {effort} is the fixed effort level such as medium or high; keep it short" },
  haiku: { id: "web.lib.assistant.pick_haiku", defaultMessage: "Fastest · {effort} effort", description: "Assistant model picker: line under Haiku in the model menu; {effort} is the fixed effort level such as medium or high; keep it short" },
});

export interface AssistantPick {
  model: string;
  effort: string;
}

export const ASSISTANT_PICKS: ReadonlyArray<AssistantPick & { label: string; hint: MessageDescriptor }> = [
  { model: "claude-opus-5-5", effort: "medium", label: "Opus 5.5", hint: PICK_MESSAGES.opus },
  { model: "claude-sonnet-5-5", effort: "high", label: "Sonnet 5.5", hint: PICK_MESSAGES.sonnet },
  { model: "claude-haiku-5-5", effort: "medium", label: "Haiku 5.5", hint: PICK_MESSAGES.haiku },
];

export type AssistantMode = "default" | "auto" | "plan" | "bypassPermissions";

const MODE_MESSAGES = defineMessages({
  default: { id: "web.lib.assistant.mode_default", defaultMessage: "Ask permissions", description: "Assistant permission mode that pauses deletes, data wipes and restores until the user approves them; keep it short" },
  auto: { id: "web.lib.assistant.mode_auto", defaultMessage: "Auto", description: "Assistant permission mode where Claude Code's auto mode approves safe shell commands itself and blocks risky ones; keep it short" },
  plan: { id: "web.lib.assistant.mode_plan", defaultMessage: "Plan", description: "Assistant permission mode where the assistant only reads and writes a plan for the user to approve before any change; keep it short" },
  bypassPermissions: { id: "web.lib.assistant.mode_bypass", defaultMessage: "Bypass permissions", description: "Assistant permission mode where every action runs at once without asking for approval; keep it short" },
});

const MODE_HINTS = defineMessages({
  default: { id: "web.lib.assistant.mode_default_hint", defaultMessage: "Deletes, wipes and restores wait for you", description: "Assistant permission mode hint: one line under Ask permissions in the mode menu; keep it short" },
  auto: { id: "web.lib.assistant.mode_auto_hint", defaultMessage: "Safe commands run, risky ones stop", description: "Assistant permission mode hint: one line under Auto in the mode menu; keep it short" },
  plan: { id: "web.lib.assistant.mode_plan_hint", defaultMessage: "Reads and plans; changes need approval", description: "Assistant permission mode hint: one line under Plan in the mode menu; keep it short" },
  bypassPermissions: { id: "web.lib.assistant.mode_bypass_hint", defaultMessage: "Every action runs without asking", description: "Assistant permission mode hint: one line under Bypass permissions in the mode menu; keep it short" },
});

export const ASSISTANT_MODES: ReadonlyArray<{ id: AssistantMode; label: MessageDescriptor; hint: MessageDescriptor }> = [
  { id: "default", label: MODE_MESSAGES.default, hint: MODE_HINTS.default },
  { id: "auto", label: MODE_MESSAGES.auto, hint: MODE_HINTS.auto },
  { id: "plan", label: MODE_MESSAGES.plan, hint: MODE_HINTS.plan },
  { id: "bypassPermissions", label: MODE_MESSAGES.bypassPermissions, hint: MODE_HINTS.bypassPermissions },
];

export interface AssistantStatus {
  enabled: boolean;
  configured: boolean;
  defaultModel: string;
  defaultEffort: string;
  defaultMode: AssistantMode;
  linear?: boolean;
}

export interface LinearAccess {
  enabled: boolean;
  comment: boolean;
  write: boolean;
  keySet: boolean;
  keyHint: string;
}

export interface LinearIssue {
  id: string;
  title: string;
  status: string;
  statusType: string;
}

export const LINEAR_METHOD = "LINEAR";
export const LINEAR_PREFIX = "linear_";

export interface AssistantScope {
  server?: string;
  namespace?: string;
  cluster?: string;
}

export type AssistantRunStatus = "running" | "awaiting_approval" | "idle" | "error";

export interface AssistantConversation {
  id: string;
  userId: number;
  username: string;
  title: string;
  cluster: string;
  namespace: string;
  server: string;
  model: string;
  effort: string;
  mode: AssistantMode;
  status: AssistantRunStatus;
  error: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: { method?: string; path?: string; query?: unknown; body?: unknown; command?: unknown; [key: string]: unknown };
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string | AssistantBlock[];
  parent?: string;
}

export interface AssistantTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface JobStatus {
  state: "running" | "exited" | "gone";
  code?: number;
  output: string;
}

export interface AssistantPending {
  id: string;
  method: string;
  path: string;
}

export interface AssistantFrame {
  text?: string;
  flush?: boolean;
}

export interface AssistantDetail {
  conversation: AssistantConversation;
  messages: AssistantMessage[];
  pending: AssistantPending[];
}

export const CONTEXT_MARKER = "\n\n<file-context>\n";

export function withContextBlock(request: string, ...contexts: string[]): string {
  const found = contexts.filter(Boolean);
  return found.length ? `${request}${CONTEXT_MARKER}${found.join("\n\n")}` : request;
}

export function requestOf(text: string): string {
  return text.split(CONTEXT_MARKER)[0];
}

export function scopeQuery(scope: AssistantScope, all: boolean): string {
  if (all) return "?scope=all";
  if (!scope.server) return "";
  const params = new URLSearchParams({ server: scope.server, namespace: scope.namespace ?? "", cluster: scope.cluster ?? "local" });
  return `?${params.toString()}`;
}

const conversationPath = (id: string, action = "") => `/ai/conversations/${encodeURIComponent(id)}${action}`;

export const Assistant = {
  status: () => api<AssistantStatus>("/ai/status"),
  list: (scope: AssistantScope, all: boolean) => api<AssistantConversation[]>(`/ai/conversations${scopeQuery(scope, all)}`),
  get: (id: string) => api<AssistantDetail>(conversationPath(id)),
  create: (prompt: string, scope: AssistantScope, mode?: AssistantMode, pick?: AssistantPick) =>
    api<AssistantConversation>("/ai/conversations", { method: "POST", body: { prompt, ...scope, mode, ...pick } }),
  send: (id: string, prompt: string, mode?: AssistantMode, pick?: AssistantPick) =>
    api<AssistantConversation>(conversationPath(id, "/messages"), { method: "POST", body: { prompt, mode, ...pick } }),
  warm: (id: string | null, scope: AssistantScope, mode?: AssistantMode, pick?: AssistantPick) =>
    api<void>(id ? conversationPath(id, "/warm") : "/ai/warm", { method: "POST", body: { ...scope, mode, ...pick } }),
  decide: (id: string, approve: boolean) =>
    api<AssistantConversation>(conversationPath(id, "/approval"), { method: "POST", body: { approve } }),
  answer: (id: string, answer: string) => api<void>(conversationPath(id, "/answer"), { method: "POST", body: { answer } }),
  cancel: (id: string) => api<void>(conversationPath(id, "/cancel"), { method: "POST" }),
  stopJob: async (scope: AssistantScope, jobId: string) => {
    if (!/^[0-9a-f]{12}$/.test(jobId)) throw new Error(`invalid job id: ${jobId}`);
    const pid = `$(cat /tmp/gameplane-jobs/${jobId}.pid 2>/dev/null)`;
    const command = `p=${pid} && { pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null; }; echo stopped`;
    const query = scope.namespace ? `?${new URLSearchParams({ namespace: scope.namespace }).toString()}` : "";
    return api<void>(`/servers/${encodeURIComponent(scope.server ?? "")}/shell${query}`, { method: "POST", body: { command }, cluster: scope.cluster });
  },
  linearIssues: () => api<LinearIssue[]>("/ai/linear/issues"),
  linear: () => api<LinearAccess>("/ai/linear"),
  putLinearKey: (apiKey: string) => api<void>("/ai/linear/key", { method: "PUT", body: { apiKey } }),
  deleteLinearKey: () => api<void>("/ai/linear/key", { method: "DELETE" }),
};

export const AssistantAdmin = {
  putSecret: (apiKey: string) => api<{ name: string; keys: string[] }>("/admin/ai/secret", { method: "PUT", body: { apiKey } }),
  putToken: (oauthToken: string) => api<{ name: string; keys: string[] }>("/admin/ai/secret", { method: "PUT", body: { oauthToken } }),
  deleteSecret: () => api<void>("/admin/ai/secret", { method: "DELETE" }),
};

export function linearTool(block: AssistantBlock): string {
  return block.name?.startsWith(LINEAR_PREFIX) ? block.name.slice(LINEAR_PREFIX.length) : "";
}

export function linearArgument(block: AssistantBlock): string {
  const input = block.input ?? {};
  const value = input.id ?? input.issueId ?? input.query ?? input.team ?? input.project;
  return typeof value === "string" ? value : "";
}

const LINEAR_MENTION = /(?:^|\s)@linear(?:\s+([A-Za-z][A-Za-z0-9]*-\d+))?(?=\s|$)/g;

export function linearMentions(text: string): string[] {
  return [...new Set([...text.matchAll(LINEAR_MENTION)].map((match) => match[1] ?? ""))];
}

export function useAssistantStatus() {
  return useQuery({ queryKey: ["ai", "status"], queryFn: Assistant.status, staleTime: 60_000 });
}

export function useAssistantStream(id: string | null, active: boolean, onFlush: () => Promise<unknown>): string {
  const [live, setLive] = useState({ id: "", text: "" });
  const flush = useRef(onFlush);
  useEffect(() => {
    flush.current = onFlush;
  }, [onFlush]);
  useEffect(() => {
    if (!id || !active || typeof EventSource === "undefined") return () => {};
    const source = new EventSource(conversationPath(id, "/stream"), { withCredentials: true });
    source.onmessage = (event) => {
      let frame: AssistantFrame;
      try {
        frame = JSON.parse(String(event.data)) as AssistantFrame;
      } catch {
        return;
      }
      if (frame.flush) {
        void flush.current().then(() => setLive({ id, text: "" }));
        return;
      }
      setLive({ id, text: frame.text ?? "" });
    };
    return () => source.close();
  }, [id, active]);
  return active && live.id === id ? live.text : "";
}

export function modelLabel(id: string): string {
  return ASSISTANT_MODELS.find((m) => m.id === id)?.label ?? id;
}

export function blocksOf(message: AssistantMessage): AssistantBlock[] {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return Array.isArray(message.content) ? message.content.filter((block) => !!block) : [];
}

export function resultText(block: AssistantBlock): string {
  if (typeof block.content === "string") return block.content;
  if (!Array.isArray(block.content)) return "";
  return block.content.map((part) => part?.text ?? "").join("\n");
}

function queryString(query: unknown): string {
  if (!query || typeof query !== "object" || Array.isArray(query)) return "";
  return new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString();
}

export const INLINE_LIMIT = 12_000;

const FILE_TOOLS = new Map([["read_file", "READ"], ["edit_file", "EDIT"], ["write_file", "WRITE"], ["read_archive", "ARCHIVE"]]);

export function callLabel(block: AssistantBlock): string {
  const input = block.input ?? {};
  if (typeof input.command === "string") return `BASH ${input.command}`;
  const fileTool = FILE_TOOLS.get(block.name ?? "");
  if (fileTool) return `${fileTool} ${String(input.file_path ?? "")}`.trim();
  const query = queryString(input.query);
  return `${String(input.method ?? "").toUpperCase()} ${String(input.path ?? "")}${query ? `?${query}` : ""}`.trim();
}

export function resultStatus(text: string): string {
  const match = /^HTTP (\d{3})/.exec(text);
  return match ? match[1] : "";
}

export interface ToolView {
  kind: string;
  action: string;
  arg: string;
}

const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

export function toolView(block: AssistantBlock): ToolView | null {
  const input = block.input ?? {};
  switch (block.name) {
    case "grep":
      return { kind: "grep", action: stringOf(input.pattern), arg: stringOf(input.path) || "/" };
    case "glob":
      return { kind: "glob", action: "", arg: stringOf(input.pattern) };
    case "WebSearch":
      return { kind: "search", action: "", arg: stringOf(input.query) };
    case "web_fetch":
      return { kind: "fetch", action: "", arg: stringOf(input.url).replace(/^https?:\/\//, "") };
    case "shell":
    case "Bash":
      return input.run_in_background === true ? { kind: "background", action: "", arg: stringOf(input.command) } : null;
    case "shell_output":
      return { kind: "job", action: "", arg: stringOf(input.job_id) };
    case "shell_stop":
      return { kind: "stop", action: "", arg: stringOf(input.job_id) };
    case "Monitor":
      return { kind: "monitor", action: "", arg: JSON.stringify(input).slice(0, 80) };
    case "TaskStop":
      return { kind: "stop", action: "", arg: JSON.stringify(input).slice(0, 80) };
    default:
      return null;
  }
}

export function jobIdOf(output: string): string {
  return /Started background job ([0-9a-f]{12})/.exec(output)?.[1] ?? "";
}

export function jobStatus(output: string): JobStatus | null {
  const lines = output.split("\n");
  const match = /^status: (running|gone|exited)(?: (-?\d+))?$/.exec(lines[0] ?? "");
  if (!match) return null;
  const state = match[1] as JobStatus["state"];
  const code = match[2] === undefined ? undefined : Number(match[2]);
  return { state, code, output: lines.slice(2).join("\n") };
}

export function latestTodos(messages: AssistantMessage[]): AssistantTodo[] | null {
  const todoBlocks = messages
    .filter((message) => !message.parent)
    .flatMap(blocksOf)
    .filter((block) => block.type === "tool_use" && block.name === "todo_write");
  const todos = todoBlocks.at(-1)?.input?.todos;
  if (!Array.isArray(todos)) return null;
  return todos.map((todo: { content?: unknown; status?: unknown }): AssistantTodo => ({
    content: String(todo.content ?? ""),
    status: todo.status === "in_progress" || todo.status === "completed" ? todo.status : "pending",
  }));
}

export function resultCount(block: AssistantBlock, output: string): number | null {
  if (block.name !== "grep" && block.name !== "glob") return null;
  if (output.startsWith("No ")) return 0;
  return output.split("\n").filter((line) => line.trim() !== "").length;
}
