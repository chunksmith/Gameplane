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

const gitPath = (target: ResourceTarget, path: string) =>
  withNS(`/${target.resource ?? "servers"}/${encodeURIComponent(target.name)}/git${path}`, target.namespace);

export const Git = {
  status: (target: ResourceTarget, signal?: AbortSignal) => api<GitStatus>(gitPath(target, "/status"), { signal }),
  diff: (target: ResourceTarget, path: string, staged: boolean) => text(gitPath(target, `/diff?path=${encodeURIComponent(path)}&staged=${staged}`)),
  stage: (target: ResourceTarget, paths: GitPaths) => api<GitStatus>(gitPath(target, "/stage"), { method: "POST", body: { paths } }),
  unstage: (target: ResourceTarget, paths: GitPaths) => api<GitStatus>(gitPath(target, "/unstage"), { method: "POST", body: { paths } }),
  discard: (target: ResourceTarget, paths: GitPaths) => api<GitStatus>(gitPath(target, "/discard"), { method: "POST", body: { paths } }),
  commit: (target: ResourceTarget, body: { summary: string; description?: string; push?: boolean }) =>
    api<{ commit: GitCommit; pushed: boolean }>(gitPath(target, "/commit"), { method: "POST", body }),
  log: (target: ResourceTarget, ref: string, signal?: AbortSignal) =>
    api<{ commits: GitCommit[]; next: string | null }>(gitPath(target, `/log?ref=${encodeURIComponent(ref)}`), { signal }),
  show: (target: ResourceTarget, sha: string, signal?: AbortSignal) =>
    api<{ commit: GitCommit; diff: string }>(gitPath(target, `/commits/${encodeURIComponent(sha)}`), { signal }),
  revert: (target: ResourceTarget, sha: string) => api<{ commit: GitCommit }>(gitPath(target, "/revert"), { method: "POST", body: { sha } }),
  undo: (target: ResourceTarget) => api<GitStatus>(gitPath(target, "/undo"), { method: "POST" }),
  branches: (target: ResourceTarget, signal?: AbortSignal) => api<GitBranch[]>(gitPath(target, "/branches"), { signal }),
  createBranch: (target: ResourceTarget, body: { name: string; checkout?: boolean }) => api<GitBranch>(gitPath(target, "/branches"), { method: "POST", body }),
  checkout: (target: ResourceTarget, branch: string) => api<GitStatus>(gitPath(target, "/checkout"), { method: "POST", body: { branch } }),
  fetch: (target: ResourceTarget) => api<GitStatus>(gitPath(target, "/fetch"), { method: "POST" }),
  pull: (target: ResourceTarget) => api<GitStatus>(gitPath(target, "/pull"), { method: "POST" }),
  push: (target: ResourceTarget, setUpstream: boolean) => api<GitStatus>(gitPath(target, "/push"), { method: "POST", body: { setUpstream } }),
  enableServer: (target: ResourceTarget) =>
    api<void>(withNS(`/servers/${encodeURIComponent(target.name)}:git`, target.namespace), { method: "PUT", body: { enabled: true } }),
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

export function useGitStatus(target: ResourceTarget, enabled = target.resource === "repositories") {
  return useQuery({
    queryKey: gitStatusKey(target),
    queryFn: ({ signal }) => Git.status(target, signal),
    enabled,
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
