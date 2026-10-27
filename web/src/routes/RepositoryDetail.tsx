import { lazy, Suspense, useMemo, useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Tab, Tabs } from "@heroui/react";
import { buttonVariants } from "@heroui/styles";
import { defineMessages, type MessageDescriptor } from "react-intl";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Copy,
  FileCode2,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Settings as SettingsIcon,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { ErrorCard } from "@/components/ui/ErrorCard";
import { LoadingCard } from "@/components/ui/LoadingCard";
import { useAssistantStatus } from "@/lib/assistant";
import { DEFAULT_NAMESPACE } from "@/lib/cluster";
import { useOptionalIntl } from "@/lib/i18n/format";
import { busyPhase, Git, gitErrorText, Repositories, REPOSITORIES_KEY, repoSlug, useGitStatus, useRepositoryRefresh } from "@/lib/repositories";
import { assistantScope, ResourceTargetProvider, type ResourceTarget, type ServerAccess } from "@/lib/resourceTarget";
import { formatRelative } from "@/lib/utils";
import type { Repository, RepositoryAccess } from "@/types";
import { AheadBehind, RepositoryAvatar } from "./Repositories";
import { GitTab } from "./repository/GitTab";
import { RepositorySettingsTab } from "./repository/SettingsTab";

const FilesTab = lazy(() => import("./tabs/Files").then((m) => ({ default: m.FilesTab })));

type TabKey = "files" | "git" | "assistant" | "settings";

const TAB_LABELS = defineMessages({
  files: { id: "web.repositories.tab_files", defaultMessage: "Files", description: "Repository detail: label of the Files tab" },
  git: { id: "web.repositories.tab_git", defaultMessage: "Git", description: "Repository detail: label of the Git tab" },
  assistant: { id: "web.repositories.tab_assistant", defaultMessage: "Assistant", description: "Repository detail: label of the Assistant tab" },
  settings: { id: "web.repositories.tab_settings", defaultMessage: "Settings", description: "Repository detail: label of the Settings tab" },
});

const TABS: Array<{ key: TabKey; label: MessageDescriptor; icon: LucideIcon }> = [
  { key: "files", label: TAB_LABELS.files, icon: FolderOpen },
  { key: "git", label: TAB_LABELS.git, icon: FileCode2 },
  { key: "assistant", label: TAB_LABELS.assistant, icon: Sparkles },
  { key: "settings", label: TAB_LABELS.settings, icon: SettingsIcon },
];

export function repositoryKey(namespace: string, name: string, ...parts: string[]) {
  return [...REPOSITORIES_KEY, namespace, name, ...parts] as const;
}

export function RepositoryDetailPage() {
  const intl = useOptionalIntl();
  const { name } = useParams({ from: "/app-layout/repositories/$name" });
  const { ns = DEFAULT_NAMESPACE } = useSearch({ from: "/app-layout/repositories/$name" });
  const repository = useQuery({
    queryKey: repositoryKey(ns, name),
    queryFn: ({ signal }) => Repositories.get(name, ns, signal),
    refetchInterval: (query) => (query.state.data && !busyPhase(query.state.data) ? 15_000 : 3_000),
  });
  const access = useQuery({
    queryKey: repositoryKey(ns, name, "access"),
    queryFn: ({ signal }) => Repositories.access(name, ns, signal),
  });
  const retry = () => { void repository.refetch(); void access.refetch(); };
  if (repository.error || access.error) return <div className="p-6"><ErrorCard message={intl.formatMessage({ id: "web.repositories.load_failed", defaultMessage: "This repository could not be loaded. Check your access and try again.", description: "Repository detail: error card when the repository or the user's access cannot be loaded" })} onRetry={retry} /></div>;
  if (!repository.data || !access.data) return <div className="p-6"><LoadingCard message={intl.formatMessage({ id: "web.repositories.loading_one", defaultMessage: "Loading repository…", description: "Repository detail: loading text while the repository is fetched" })} /></div>;
  return <RepositoryView repository={repository.data} access={access.data} />;
}

function RepositoryView({ repository, access }: { repository: Repository; access: RepositoryAccess }) {
  const intl = useOptionalIntl();
  const nav = useNavigate();
  const assistant = useAssistantStatus();
  const [tab, setTab] = useState<TabKey>("git");
  const { name, namespace, uid } = repository;
  const target = useMemo<ResourceTarget>(() => Object.freeze({ cluster: "local", namespace, name, uid, resource: "repositories" }), [namespace, name, uid]);
  const permissions = access.permissions;
  const canWrite = permissions.includes("repositories:write");
  const canPush = permissions.includes("repositories:push");
  const canManage = permissions.includes("repositories:manage");
  const serverAccess = useMemo<ServerAccess>(() => ({
    canWrite, canControl: canWrite, canConsole: false, canDelete: canManage, isOwner: access.isOwner, isCollaborator: access.isCollaborator, permissions,
  }), [canWrite, canManage, access.isOwner, access.isCollaborator, permissions]);
  const refresh = useRepositoryRefresh(target);
  const status = useGitStatus(target);
  const ready = repository.phase === "Ready";
  const { _splat: filesSplat } = useParams({ strict: false });
  const filesPath = filesSplat === undefined ? null : `/${filesSplat}`;
  const activeTab = filesPath === null ? tab : "files";
  const search = { ns: namespace };

  function openFiles(path: string) {
    void nav({ to: "/repositories/$name/files/$", params: { name, _splat: path.replace(/^\/+/, "") }, search });
  }

  function selectTab(key: TabKey) {
    if (key === "files") return openFiles("/");
    setTab(key);
    if (filesPath !== null) void nav({ to: "/repositories/$name", params: { name }, search });
  }

  const action = useMutation({
    mutationFn: (verb: "pull" | "push" | "fetch" | "reclone"): Promise<unknown> => {
      if (verb === "pull") return Git.pull(name, namespace);
      if (verb === "push") return Git.push(name, !status.data?.upstream, namespace);
      if (verb === "fetch") return Git.fetch(name, namespace);
      return Repositories.reclone(name, namespace);
    },
    onSettled: refresh,
  });

  const visibleTabs = TABS.filter((item) => item.key !== "assistant" || assistant.data?.enabled === true);
  const branch = status.data?.branch ?? repository.branch;
  const meta = [
    repository.url.replace(/^https:\/\//, ""),
    intl.formatMessage({ id: "web.repositories.changes", defaultMessage: "{count, plural, one {# change} other {# changes}}", description: "Repositories: chip with the number of uncommitted changes; {count} is the number" }, { count: repository.changes }),
    repository.lastFetch && intl.formatMessage({ id: "web.repositories.fetched", defaultMessage: "fetched {when}", description: "Repository detail: header text with the last fetch time; {when} is a relative time" }, { when: formatRelative(repository.lastFetch, intl) }),
    repository.network && intl.formatMessage({ id: "web.repositories.network_chip", defaultMessage: "network: {network}", description: "Repositories: chip naming the repository's network; {network} is the network name" }, { network: repository.network }),
  ].filter(Boolean);
  const separator = intl.formatMessage({ id: "web.common.separator_dot", defaultMessage: "·", description: "Visual separator between two items" });
  const metaText = meta.join(` ${separator} `);

  return (
    <ResourceTargetProvider target={target} access={serverAccess}>
      <div className="flex h-full flex-col">
        <header className="border-b border-border bg-background px-4 pt-3 md:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
            <div className="flex min-w-0 items-center gap-3">
              <RepositoryAvatar name={name} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="truncate font-mono text-base font-semibold text-foreground">{name}</h1>
                  {branch && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />{branch}
                    </span>
                  )}
                  <span className="hidden text-xs text-muted md:inline">
                    {metaText}
                    {ready && <> {separator} <AheadBehind ahead={repository.ahead} behind={repository.behind} /></>}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="rounded-full" isDisabled={!ready || !canWrite || action.isPending} onPress={() => action.mutate("pull")}>
                <ArrowDown className="h-4 w-4" />{intl.formatMessage({ id: "web.repositories.pull", defaultMessage: "Pull", description: "Repository detail: header button that pulls with rebase; keep it short" })}
              </Button>
              <Button variant="outline" size="sm" className="rounded-full" isDisabled={!ready || !canPush || action.isPending} onPress={() => action.mutate("push")}>
                <ArrowUp className="h-4 w-4" />{intl.formatMessage({ id: "web.repositories.push", defaultMessage: "Push", description: "Repository detail: header button that pushes the branch; keep it short" })}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  className={buttonVariants({ isIconOnly: true, variant: "ghost", size: "sm" })}
                  aria-label={intl.formatMessage({ id: "web.repositories.more_actions", defaultMessage: "Repository actions", description: "Repository detail: accessible name of the icon-only menu button with more actions; not shown as text" })}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem icon={<RefreshCw className="h-4 w-4" />} label={intl.formatMessage(ACTION_LABELS.fetch)} onSelect={() => action.mutate("fetch")} disabled={!ready || !canWrite} />
                  <DropdownMenuItem icon={<RotateCcw className="h-4 w-4" />} label={intl.formatMessage(ACTION_LABELS.reclone)} onSelect={() => action.mutate("reclone")} disabled={!canManage || busyPhase(repository)} destructive />
                  <DropdownMenuItem icon={<Copy className="h-4 w-4" />} label={intl.formatMessage(ACTION_LABELS.copy_url)} onSelect={() => void navigator.clipboard.writeText(repository.url)} />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {action.error && <div className="pb-2"><ErrorBanner err={gitErrorText(intl, action.error)} onDismiss={() => action.reset()} /></div>}
          <nav className="-mb-px overflow-x-auto scrollbar-thin">
            <Tabs selectedKey={activeTab} onSelectionChange={(key) => selectTab(key as TabKey)} className="server-detail-tabs">
              <Tabs.List aria-label={intl.formatMessage({ id: "web.repositories.tabs", defaultMessage: "Repository tabs", description: "Repository detail: accessible name of the row of tabs; not shown as text" })}>
                {visibleTabs.map(({ key, label, icon: Icon }) => (
                  <Tab key={key} id={key}>
                    <Icon className="h-4 w-4" />
                    {intl.formatMessage(label)}
                    <Tabs.Indicator />
                  </Tab>
                ))}
              </Tabs.List>
            </Tabs>
          </nav>
        </header>

        <div className="flex-1 overflow-auto scrollbar-thin">
          {activeTab === "settings" ? (
            <RepositorySettingsTab repository={repository} target={target} permissions={permissions} />
          ) : !ready ? (
            <ClonePanel repository={repository} canManage={canManage} onReclone={() => action.mutate("reclone")} />
          ) : (
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" /></div>}>
              {activeTab === "files" && <FilesTab name={name} ns={namespace} path={filesPath ?? "/"} onNavigate={openFiles} />}
              {activeTab === "git" && <GitTab repository={repository} target={target} permissions={permissions} />}
              {activeTab === "assistant" && <div className="p-4 sm:p-6"><AssistantPanel scope={assistantScope(target)} /></div>}
            </Suspense>
          )}
        </div>
      </div>
    </ResourceTargetProvider>
  );
}

const ACTION_LABELS = defineMessages({
  fetch: { id: "web.repositories.fetch", defaultMessage: "Fetch", description: "Repository: action that fetches from GitHub without changing files; keep it short" },
  reclone: { id: "web.repositories.reclone", defaultMessage: "Re-clone", description: "Repository detail: menu item that deletes the working copy and clones again; keep it short" },
  copy_url: { id: "web.repositories.copy_url", defaultMessage: "Copy URL", description: "Repository detail: menu item that copies the repository URL; keep it short" },
});

function ClonePanel({ repository, canManage, onReclone }: { repository: Repository; canManage: boolean; onReclone: () => void }) {
  const intl = useOptionalIntl();
  if (repository.phase === "Failed") {
    return (
      <div className="mx-auto max-w-lg space-y-3 p-10 text-center">
        <AlertTriangle className="mx-auto h-6 w-6 text-danger" />
        <p className="text-sm font-medium">{intl.formatMessage({ id: "web.repositories.clone_failed", defaultMessage: "The clone failed.", description: "Repository detail: title when the first clone failed" })}</p>
        {repository.error && <p className="text-xs text-muted">{repository.error}</p>}
        {canManage && <Button variant="primary" onPress={onReclone}>{intl.formatMessage(ACTION_LABELS.reclone)}</Button>}
      </div>
    );
  }
  const cloning = repository.phase === "Cloning";
  return (
    <div className="mx-auto max-w-md space-y-3 p-10 text-center">
      <Loader2 className="mx-auto h-6 w-6 animate-spin text-accent" />
      <p className="text-sm">{cloning
        ? intl.formatMessage({ id: "web.repositories.cloning_progress", defaultMessage: "Cloning… {progress}%", description: "Repository detail: text while the repository is cloning; {progress} is the progress percentage" }, { progress: repository.cloneProgress ?? 0 })
        : intl.formatMessage({ id: "web.repositories.waiting_agent", defaultMessage: "Waiting for the repository agent to start…", description: "Repository detail: text while the repository agent pod is starting" })}</p>
      {cloning && (
        <div role="progressbar" aria-valuenow={repository.cloneProgress ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label={intl.formatMessage({ id: "web.repositories.clone_progress", defaultMessage: "Clone progress", description: "Repository detail: accessible name of the clone progress bar; not shown as text" })} className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${repository.cloneProgress ?? 0}%` }} />
        </div>
      )}
      <p className="text-xs text-muted">{repoSlug(repository.url)}</p>
    </div>
  );
}
