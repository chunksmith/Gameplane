import { api } from "@/lib/api";
import type { AssistantConversation } from "@/lib/assistant";
import type { LinearIssueView, LinearIssuePage, LinearListIssue, LinearProject, LinearRepoLink, LinearTeam, LinearView } from "@/types";

export interface LinearListQuery {
  view: LinearView;
  team?: string;
  status?: string[];
  q?: string;
  sort?: "priority" | "updated";
  cursor?: string;
}

export const LINEAR_KEY = ["linear"] as const;

export function listParams(query: LinearListQuery): string {
  const params = new URLSearchParams({ view: query.view });
  if (query.team) params.set("team", query.team);
  if (query.status?.length) params.set("status", query.status.join(","));
  if (query.q) params.set("q", query.q);
  if (query.sort) params.set("sort", query.sort);
  if (query.cursor) params.set("cursor", query.cursor);
  return params.toString();
}

export const Linear = {
  teams: () => api<LinearTeam[]>("/ai/linear/teams"),
  projects: () => api<LinearProject[]>("/ai/linear/projects"),
  issues: (query: LinearListQuery) => api<LinearIssuePage>(`/ai/linear/issues?${listParams(query)}`),
  issue: (id: string) => api<LinearIssueView>(`/ai/linear/issues/${encodeURIComponent(id)}`),
  solve: (id: string, body: { repository: string; namespace: string; message: string }) =>
    api<{ conversation: AssistantConversation }>(`/ai/linear/issues/${encodeURIComponent(id)}/solve`, { method: "POST", body }),
  links: () => api<LinearRepoLink[]>("/ai/linear/links"),
  putLinks: (links: LinearRepoLink[]) => api<LinearRepoLink[]>("/ai/linear/links", { method: "PUT", body: links }),
};

export function priorityLabel(value: number): string {
  return value >= 1 && value <= 4 ? `P${value}` : "";
}

export function statusDot(issue: Pick<LinearListIssue, "status" | "statusType">): string {
  if (issue.statusType === "completed") return "bg-success";
  if (issue.statusType === "started") return /review/i.test(issue.status) ? "bg-accent" : "bg-warning";
  if (issue.statusType === "canceled") return "bg-danger";
  return "bg-muted";
}

export function workspaceOf(url: string): string {
  return /^https:\/\/linear\.app\/([^/]+)\/issue\//.exec(url)?.[1] ?? "";
}
