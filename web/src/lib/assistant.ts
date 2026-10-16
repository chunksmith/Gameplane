import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

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

export interface AssistantStatus {
  enabled: boolean;
  configured: boolean;
  defaultModel: string;
  defaultEffort: string;
}

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
  input?: { method?: string; path?: string; query?: unknown; body?: unknown };
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
  create: (prompt: string, scope: AssistantScope) =>
    api<AssistantConversation>("/ai/conversations", { method: "POST", body: { prompt, ...scope } }),
  send: (id: string, prompt: string) =>
    api<AssistantConversation>(conversationPath(id, "/messages"), { method: "POST", body: { prompt } }),
  decide: (id: string, approve: boolean) =>
    api<AssistantConversation>(conversationPath(id, "/approval"), { method: "POST", body: { approve } }),
  cancel: (id: string) => api<void>(conversationPath(id, "/cancel"), { method: "POST" }),
};

export const AssistantAdmin = {
  putSecret: (apiKey: string) => api<{ name: string; keys: string[] }>("/admin/ai/secret", { method: "PUT", body: { apiKey } }),
  putToken: (oauthToken: string) => api<{ name: string; keys: string[] }>("/admin/ai/secret", { method: "PUT", body: { oauthToken } }),
  deleteSecret: () => api<void>("/admin/ai/secret", { method: "DELETE" }),
};

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
  const query = queryString(input.query);
  return `${String(input.method ?? "").toUpperCase()} ${String(input.path ?? "")}${query ? `?${query}` : ""}`.trim();
}

export function resultStatus(text: string): string {
  const match = /^HTTP (\d{3})/.exec(text);
  return match ? match[1] : "";
}
