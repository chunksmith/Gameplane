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

export type AssistantMode = "default" | "auto" | "bypassPermissions";

const MODE_MESSAGES = defineMessages({
  default: { id: "web.lib.assistant.mode_default", defaultMessage: "Ask permissions", description: "Assistant permission mode that pauses deletes, data wipes and restores until the user approves them; keep it short" },
  auto: { id: "web.lib.assistant.mode_auto", defaultMessage: "Auto", description: "Assistant permission mode where Claude Code's auto mode approves safe shell commands itself and blocks risky ones; keep it short" },
  bypassPermissions: { id: "web.lib.assistant.mode_bypass", defaultMessage: "Bypass permissions", description: "Assistant permission mode where every action runs at once without asking for approval; keep it short" },
});

export const ASSISTANT_MODES: ReadonlyArray<{ id: AssistantMode; label: MessageDescriptor }> = [
  { id: "default", label: MODE_MESSAGES.default },
  { id: "auto", label: MODE_MESSAGES.auto },
  { id: "bypassPermissions", label: MODE_MESSAGES.bypassPermissions },
];

export interface AssistantStatus {
  enabled: boolean;
  configured: boolean;
  defaultModel: string;
  defaultEffort: string;
  defaultMode: AssistantMode;
  linear?: boolean;
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
  decide: (id: string, approve: boolean) =>
    api<AssistantConversation>(conversationPath(id, "/approval"), { method: "POST", body: { approve } }),
  cancel: (id: string) => api<void>(conversationPath(id, "/cancel"), { method: "POST" }),
  linearIssues: () => api<LinearIssue[]>("/ai/linear/issues"),
};

export const AssistantAdmin = {
  putSecret: (apiKey: string) => api<{ name: string; keys: string[] }>("/admin/ai/secret", { method: "PUT", body: { apiKey } }),
  putToken: (oauthToken: string) => api<{ name: string; keys: string[] }>("/admin/ai/secret", { method: "PUT", body: { oauthToken } }),
  deleteSecret: () => api<void>("/admin/ai/secret", { method: "DELETE" }),
  putLinearKey: (apiKey: string) => api<{ name: string; keys: string[] }>("/admin/ai/linear/secret", { method: "PUT", body: { apiKey } }),
  deleteLinearKey: () => api<void>("/admin/ai/linear/secret", { method: "DELETE" }),
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

export function callLabel(block: AssistantBlock): string {
  const input = block.input ?? {};
  if (typeof input.command === "string") return `BASH ${input.command}`;
  const query = queryString(input.query);
  return `${String(input.method ?? "").toUpperCase()} ${String(input.path ?? "")}${query ? `?${query}` : ""}`.trim();
}

export function resultStatus(text: string): string {
  const match = /^HTTP (\d{3})/.exec(text);
  return match ? match[1] : "";
}
