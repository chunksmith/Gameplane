import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { IntlShape } from "react-intl";
import { APIError, api } from "@/lib/api";
import { errorTextIntl } from "@/lib/errors";
import { resourceKey, type ResourceTarget } from "@/lib/resourceTarget";
import type {
  GitBranch,
  GitCommit,
  GitFileState,
  GitHubIntegration,
  GitStatus,
  Repository,
  RepositoryAccess,
  RepositoryCollaborator,
  RepositoryCreate,
} from "@/types";

export type GitPaths = string[] | "all";

export const REPOSITORIES_KEY = ["repositories"] as const;

export interface RepositoryProps {
  repository: Repository;
  target: ResourceTarget;
  permissions: readonly string[];
}

export function busyPhase(repository: Repository): boolean {
  return repository.phase === "Pending" || repository.phase === "Cloning";
}

export function useRepositoryRefresh(target: ResourceTarget) {
  const qc = useQueryClient();
  return async () => {
    await qc.invalidateQueries({ queryKey: REPOSITORIES_KEY });
    await qc.invalidateQueries({ queryKey: resourceKey(target) });
  };
}

const base = (name: string, path = "") => `/repositories/${encodeURIComponent(name)}${path}`;

function withNS(path: string, ns?: string): string {
  if (!ns) return path;
  return `${path}${path.includes("?") ? "&" : "?"}namespace=${encodeURIComponent(ns)}`;
}

async function text(path: string): Promise<string> {
  const res = await fetch(path, { credentials: "include", cache: "no-store" });
  const body = await res.text();
  if (!res.ok) throw new APIError(res.status, body, res.statusText, res.headers.get("content-type") ?? undefined);
  return body;
}

export const Repositories = {
  list: (signal?: AbortSignal) => api<Repository[]>("/repositories", { signal }),
  get: (name: string, ns?: string, signal?: AbortSignal) => api<Repository>(withNS(base(name), ns), { signal }),
  create: (body: RepositoryCreate, ns?: string) => api<Repository>(withNS("/repositories", ns), { method: "POST", body }),
  remove: (name: string, ns?: string) => api<void>(withNS(base(name), ns), { method: "DELETE" }),
  access: (name: string, ns?: string, signal?: AbortSignal) => api<RepositoryAccess>(withNS(base(name, "/access"), ns), { signal }),
  setNetwork: (name: string, network: string, ns?: string) => api<void>(withNS(base(name, ":network"), ns), { method: "PUT", body: { network } }),
  reclone: (name: string, ns?: string) => api<Repository>(withNS(base(name, ":reclone"), ns), { method: "POST" }),
  collaborators: (name: string, ns?: string, signal?: AbortSignal) => api<RepositoryCollaborator[]>(withNS(base(name, "/collaborators"), ns), { signal }),
  addCollaborator: (name: string, username: string, grants: { edit: boolean; push: boolean }, ns?: string) =>
    api<void>(withNS(base(name, "/collaborators"), ns), { method: "POST", body: { username, ...grants } }),
  setCollaborator: (name: string, userId: number, grants: { edit: boolean; push: boolean }, ns?: string) =>
    api<void>(withNS(base(name, `/collaborators/${userId}`), ns), { method: "PUT", body: grants }),
  removeCollaborator: (name: string, userId: number, ns?: string) =>
    api<void>(withNS(base(name, `/collaborators/${userId}`), ns), { method: "DELETE" }),
};

export const Git = {
  status: (name: string, ns?: string, signal?: AbortSignal) => api<GitStatus>(withNS(base(name, "/git/status"), ns), { signal }),
  diff: (name: string, path: string, staged: boolean, ns?: string) =>
    text(withNS(base(name, `/git/diff?path=${encodeURIComponent(path)}&staged=${staged}`), ns)),
  stage: (name: string, paths: GitPaths, ns?: string) => api<GitStatus>(withNS(base(name, "/git/stage"), ns), { method: "POST", body: { paths } }),
  unstage: (name: string, paths: GitPaths, ns?: string) => api<GitStatus>(withNS(base(name, "/git/unstage"), ns), { method: "POST", body: { paths } }),
  discard: (name: string, paths: GitPaths, ns?: string) => api<GitStatus>(withNS(base(name, "/git/discard"), ns), { method: "POST", body: { paths } }),
  commit: (name: string, body: { summary: string; description?: string; push?: boolean }, ns?: string) =>
    api<{ commit: GitCommit; pushed: boolean }>(withNS(base(name, "/git/commit"), ns), { method: "POST", body }),
  log: (name: string, ref: string, ns?: string, signal?: AbortSignal) =>
    api<{ commits: GitCommit[]; next: string | null }>(withNS(base(name, `/git/log?ref=${encodeURIComponent(ref)}`), ns), { signal }),
  show: (name: string, sha: string, ns?: string, signal?: AbortSignal) =>
    api<{ commit: GitCommit; diff: string }>(withNS(base(name, `/git/commits/${encodeURIComponent(sha)}`), ns), { signal }),
  revert: (name: string, sha: string, ns?: string) => api<{ commit: GitCommit }>(withNS(base(name, "/git/revert"), ns), { method: "POST", body: { sha } }),
  undo: (name: string, ns?: string) => api<GitStatus>(withNS(base(name, "/git/undo"), ns), { method: "POST" }),
  branches: (name: string, ns?: string, signal?: AbortSignal) => api<GitBranch[]>(withNS(base(name, "/git/branches"), ns), { signal }),
  createBranch: (name: string, body: { name: string; checkout?: boolean }, ns?: string) => api<GitBranch>(withNS(base(name, "/git/branches"), ns), { method: "POST", body }),
  checkout: (name: string, branch: string, ns?: string) => api<GitStatus>(withNS(base(name, "/git/checkout"), ns), { method: "POST", body: { branch } }),
  fetch: (name: string, ns?: string) => api<GitStatus>(withNS(base(name, "/git/fetch"), ns), { method: "POST" }),
  pull: (name: string, ns?: string) => api<GitStatus>(withNS(base(name, "/git/pull"), ns), { method: "POST" }),
  push: (name: string, setUpstream: boolean, ns?: string) => api<GitStatus>(withNS(base(name, "/git/push"), ns), { method: "POST", body: { setUpstream } }),
};

export const GitHub = {
  get: () => api<GitHubIntegration>("/integrations/github"),
  putToken: (token: string) => api<GitHubIntegration>("/integrations/github/token", { method: "PUT", body: { token } }),
  deleteToken: () => api<void>("/integrations/github/token", { method: "DELETE" }),
};

export function useGitHub() {
  return useQuery({ queryKey: ["integrations", "github"], queryFn: GitHub.get });
}

export function gitStatusKey(target: ResourceTarget) {
  return resourceKey(target, "git-status");
}

export function useGitStatus(target: ResourceTarget) {
  return useQuery({
    queryKey: gitStatusKey(target),
    queryFn: ({ signal }) => Git.status(target.name, target.namespace, signal),
    enabled: target.resource === "repositories",
    refetchInterval: 10_000,
  });
}

export function useGitMarks(target: ResourceTarget): ReadonlyMap<string, GitFileState> {
  const status = useGitStatus(target);
  return new Map((status.data?.changes ?? []).filter((change) => !change.path.endsWith("/")).map((change) => [`/${change.path}`, change.state]));
}

export const GIT_STATE_CLASS: Record<GitFileState, string> = {
  M: "text-warning",
  A: "text-success",
  U: "text-success",
  R: "text-accent",
  D: "text-danger",
};

export function gitErrorText(intl: IntlShape, err: unknown): string {
  const message = errorTextIntl(intl, err);
  if (!(err instanceof APIError) || !err.files?.length) return message;
  return intl.formatMessage(
    { id: "web.repositories.error_with_files", defaultMessage: "{message} Files: {files}", description: "Repository: error text followed by the conflicted file paths; {message} is the error and {files} a comma-separated list of paths" },
    { message, files: err.files.join(", ") },
  );
}

export function repoSlug(url: string): string {
  return url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
}

export function initials(name: string): string {
  return name.split(/[-_.\s]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}
