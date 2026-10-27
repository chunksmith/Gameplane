import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Button,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContainer,
  ModalDialog,
  ModalFooter,
  ModalHeader,
  ModalHeading,
  Select,
  TextArea,
  TextField,
} from "@heroui/react";
import { defineMessages, type IntlShape, type MessageDescriptor } from "react-intl";
import { ArrowLeft, Copy, FileText, GitBranch, Loader2, Plus, RefreshCw, RotateCcw, Undo2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useOptionalIntl } from "@/lib/i18n/format";
import { Git, GIT_STATE_CLASS, gitErrorText, useGitHub, useGitStatus, useRepositoryRefresh, type GitPaths, type RepositoryProps } from "@/lib/repositories";
import { resourceKey, useResourceClient, type ResourceTarget } from "@/lib/resourceTarget";
import { cn, formatRelative } from "@/lib/utils";
import type { GitChange, GitCommit, Repository } from "@/types";
import { AheadBehind } from "../Repositories";

const M: Record<string, MessageDescriptor> = defineMessages({
  changes: { id: "web.repositories.git.changes_toggle", defaultMessage: "Changes · {count}", description: "Git tab: toggle button that shows the uncommitted changes; {count} is the number of changed files" },
  history: { id: "web.repositories.git.history", defaultMessage: "History", description: "Git tab: toggle button that shows the commit history; keep it short" },
  staged: { id: "web.repositories.git.staged", defaultMessage: "Staged · {count}", description: "Git tab: heading of the staged files list; {count} is the number of files" },
  unstaged: { id: "web.repositories.git.unstaged", defaultMessage: "Changes · {count}", description: "Git tab: heading of the unstaged changes list; {count} is the number of files" },
  unstage_all: { id: "web.repositories.git.unstage_all", defaultMessage: "Unstage all", description: "Git tab: link that unstages every staged file; keep it short" },
  stage_all: { id: "web.repositories.git.stage_all", defaultMessage: "Stage all", description: "Git tab: link that stages every changed file; keep it short" },
  discard_all: { id: "web.repositories.git.discard_all", defaultMessage: "Discard all", description: "Git tab: link that discards every unstaged change; keep it short" },
  stage_file: { id: "web.repositories.git.stage_file", defaultMessage: "Stage file", description: "Git tab: button above a diff that stages the file; keep it short" },
  unstage_file: { id: "web.repositories.git.unstage_file", defaultMessage: "Unstage file", description: "Git tab: button above a diff that unstages the file; keep it short" },
  discard: { id: "web.repositories.git.discard", defaultMessage: "Discard", description: "Git tab: button that discards the selected file's changes; keep it short" },
  discard_title: { id: "web.repositories.git.discard_title", defaultMessage: "Discard {target}?", description: "Git tab: title of the confirm dialog before discarding; {target} is a file path or the words for all changes" },
  discard_body: { id: "web.repositories.git.discard_body", defaultMessage: "The uncommitted changes are lost for everyone working on this repository. This cannot be undone.", description: "Git tab: body of the confirm dialog before discarding changes" },
  all_changes: { id: "web.repositories.git.all_changes", defaultMessage: "all changes", description: "Git tab: words used in the discard dialog title when every change is discarded" },
  summary: { id: "web.repositories.git.summary", defaultMessage: "Summary", description: "Git tab: placeholder and accessible name of the commit summary field" },
  description: { id: "web.repositories.git.description", defaultMessage: "Description (optional)", description: "Git tab: placeholder and accessible name of the commit description field" },
  token_note: { id: "web.repositories.git.token_note", defaultMessage: "Commits and pushes use your own GitHub token (@{login}).", description: "Git tab: note under the commit fields; {login} is the user's GitHub login" },
  token_missing: { id: "web.repositories.git.token_missing", defaultMessage: "Connect your GitHub token in Settings, Integrations to commit and push.", description: "Git tab: note under the commit fields when the user has no GitHub token" },
  commit: { id: "web.repositories.git.commit", defaultMessage: "{count, plural, one {Commit # file} other {Commit # files}}", description: "Git tab: button that commits the staged files; {count} is the number of staged files" },
  commit_push: { id: "web.repositories.git.commit_push", defaultMessage: "Commit & push", description: "Git tab: button that commits the staged files and pushes; keep it short" },
  select_file: { id: "web.repositories.git.select_file", defaultMessage: "Select a file to see its changes.", description: "Git tab: empty diff panel text" },
  select_commit: { id: "web.repositories.git.select_commit", defaultMessage: "Select a commit to see it.", description: "Git tab: empty commit panel text" },
  no_changes: { id: "web.repositories.git.no_changes", defaultMessage: "No uncommitted changes.", description: "Git tab: text when the working copy is clean" },
  back: { id: "web.repositories.git.back", defaultMessage: "Changes", description: "Git tab: back button on mobile from a diff to the changes list; keep it short" },
  not_pushed: { id: "web.repositories.git.not_pushed", defaultMessage: "Not pushed · {count}", description: "Git tab History: heading of the local commits that are not pushed; {count} is the number" },
  undo: { id: "web.repositories.git.undo", defaultMessage: "Undo last commit", description: "Git tab History: link that undoes the last unpushed commit, keeping its changes staged; keep it short" },
  to_pull: { id: "web.repositories.git.to_pull", defaultMessage: "↓{count} to pull", description: "Git tab History: number of upstream commits not pulled yet; {count} is the number" },
  copy_sha: { id: "web.repositories.git.copy_sha", defaultMessage: "Copy SHA", description: "Git tab History: button that copies the commit SHA; keep it short" },
  revert: { id: "web.repositories.git.revert", defaultMessage: "Revert commit", description: "Git tab History: button that creates a commit undoing the selected commit; keep it short" },
  commit_meta: { id: "web.repositories.git.commit_meta", defaultMessage: "{author} · {when} · {count, plural, one {# file} other {# files}}", description: "Git tab History: line about the selected commit; {author} is the author, {when} a relative time, {count} the number of files" },
  commit_row: { id: "web.repositories.git.commit_row", defaultMessage: "{author} · {when} · {sha}", description: "Git tab History: second line of a commit row; {author} is the author, {when} a relative time, {sha} the short SHA" },
  new_branch: { id: "web.repositories.git.new_branch", defaultMessage: "New branch", description: "Git tab: button that opens the new branch dialog, and its title; keep it short" },
  branch_name: { id: "web.repositories.git.branch_name", defaultMessage: "Branch name", description: "Git tab: label of the new branch name field" },
  create: { id: "web.repositories.git.create", defaultMessage: "Create", description: "Git tab: button that creates the new branch; keep it short" },
  cancel: { id: "web.repositories.cancel", defaultMessage: "Cancel", description: "Repositories: button that closes a dialog without changes" },
  branch: { id: "web.repositories.git.branch", defaultMessage: "Branch", description: "Git tab: accessible name of the branch picker; not shown as text" },
  tracking: { id: "web.repositories.git.tracking", defaultMessage: "tracking {upstream}", description: "Git tab: text beside the branch picker naming the upstream branch; {upstream} is like origin/main" },
  no_upstream: { id: "web.repositories.git.no_upstream", defaultMessage: "not pushed yet", description: "Git tab: text beside the branch picker when the branch has no upstream" },
  remote_branches: { id: "web.repositories.git.remote_branches", defaultMessage: "Remote branches", description: "Git tab: accessible name of the branch picker section that lists remote branches without a local copy" },
  refresh: { id: "web.repositories.git.refresh", defaultMessage: "Refresh", description: "Git tab: accessible name of the icon-only refresh button; not shown as text" },
  fetch: { id: "web.repositories.fetch", defaultMessage: "Fetch", description: "Repository: action that fetches from GitHub without changing files; keep it short" },
  separator: { id: "web.common.separator_dot", defaultMessage: "·", description: "Visual separator between two items" },
  login: { id: "web.repositories.git.login", defaultMessage: "@{login}", description: "Git tab: a GitHub login shown as the commit author; {login} is the login" },
  view: { id: "web.repositories.git.view", defaultMessage: "Git view", description: "Git tab: accessible name of the Changes and History toggle; not shown as text" },
});

type Selection = { path: string; staged: boolean; untracked: boolean } | null;

export function GitTab({ repository, target, permissions }: RepositoryProps) {
  const intl = useOptionalIntl();
  const { name, namespace } = repository;
  const canWrite = permissions.includes("repositories:write");
  const canPush = permissions.includes("repositories:push");
  const [view, setView] = useState<"changes" | "history">("changes");
  const [branchPrompt, setBranchPrompt] = useState(false);
  const status = useGitStatus(target);
  const refresh = useRepositoryRefresh(target);
  const branches = useQuery({ queryKey: resourceKey(target, "git-branches"), queryFn: ({ signal }) => Git.branches(name, namespace, signal) });
  const action = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSettled: refresh,
  });
  const run = (call: () => Promise<unknown>) => action.mutate(call);
  const local = (branches.data ?? []).filter((branch) => !branch.name.startsWith("origin/"));
  const remote = (branches.data ?? []).filter((branch) => branch.name.startsWith("origin/") && !local.some((other) => other.name === branch.name.slice("origin/".length)));
  const data = status.data;

  return (
    <div className="flex min-h-full flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <GitBranch className="h-4 w-4 text-muted" />
          <Select aria-label={intl.formatMessage(M.branch)} value={data?.branch ?? ""} isDisabled={!canWrite || action.isPending} onChange={(value) => value && value !== data?.branch && run(() => Git.checkout(name, String(value), namespace))}>
            <Select.Trigger className="items-center gap-1 rounded px-1 py-0.5 text-sm hover:bg-foreground/5">
              <Select.Value />
              <Select.Indicator className="h-3.5 w-3.5" />
            </Select.Trigger>
            <Select.Popover className="rounded border border-border">
              <ListBox className="p-0">
                {local.map((branch) => <ListBoxItem key={branch.name} id={branch.name}>{branch.name}</ListBoxItem>)}
                {remote.length > 0 && (
                  <ListBox.Section aria-label={intl.formatMessage(M.remote_branches)}>
                    {remote.map((branch) => <ListBoxItem key={branch.name} id={branch.name}>{branch.name}</ListBoxItem>)}
                  </ListBox.Section>
                )}
              </ListBox>
            </Select.Popover>
          </Select>
          {data && (
            <span className="truncate text-xs text-muted">
              {data.upstream ? intl.formatMessage(M.tracking, { upstream: data.upstream }) : intl.formatMessage(M.no_upstream)}
              {data.upstream && <> {intl.formatMessage(M.separator)} <AheadBehind ahead={data.ahead} behind={data.behind} /></>}
            </span>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div role="group" aria-label={intl.formatMessage(M.view)} className="flex rounded-lg border border-border p-0.5">
            {(["changes", "history"] as const).map((key) => (
              <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)} className={cn("rounded-md px-3 py-1 text-xs", view === key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground")}>
                {key === "changes" ? intl.formatMessage(M.changes, { count: data?.changes.length ?? 0 }) : intl.formatMessage(M.history)}
              </button>
            ))}
          </div>
          <Button isIconOnly variant="ghost" size="sm" aria-label={intl.formatMessage(M.refresh)} onPress={() => void refresh()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button variant="secondary" size="sm" isDisabled={!canWrite} onPress={() => setBranchPrompt(true)}>
            <Plus className="h-4 w-4" />{intl.formatMessage(M.new_branch)}
          </Button>
          <Button variant="primary" size="sm" isDisabled={!canWrite || action.isPending} onPress={() => run(() => Git.fetch(name, namespace))}>
            <RefreshCw className="h-4 w-4" />{intl.formatMessage(M.fetch)}
          </Button>
        </div>
      </div>

      {action.error && <ErrorBanner err={gitErrorText(intl, action.error)} onDismiss={() => action.reset()} />}
      {status.error && <ErrorBanner err={gitErrorText(intl, status.error)} />}

      {!data ? (
        <div className="grid flex-1 place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted" /></div>
      ) : view === "changes" ? (
        <ChangesView repository={repository} target={target} permissions={permissions} changes={data.changes} busy={action.isPending} run={run} canWrite={canWrite} canPush={canPush} />
      ) : (
        <HistoryView repository={repository} target={target} permissions={permissions} upstream={data.upstream} behind={data.behind} busy={action.isPending} run={run} canWrite={canWrite} />
      )}

      <NewBranchDialog open={branchPrompt} onOpenChange={setBranchPrompt} onCreate={(branch) => run(() => Git.createBranch(name, { name: branch, checkout: true }, namespace))} />
    </div>
  );
}

interface ActionProps extends RepositoryProps {
  busy: boolean;
  run: (call: () => Promise<unknown>) => void;
  canWrite: boolean;
}

function ChangesView({ repository, target, changes, busy, run, canWrite, canPush }: ActionProps & { changes: GitChange[]; canPush: boolean }) {
  const intl = useOptionalIntl();
  const { name, namespace } = repository;
  const github = useGitHub();
  const [selected, setSelected] = useState<Selection>(null);
  const [discard, setDiscard] = useState<GitPaths | null>(null);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const staged = changes.filter((change) => change.staged);
  const unstaged = changes.filter((change) => !change.staged);
  const current = selected && changes.find((change) => change.path === selected.path && change.staged === selected.staged);
  const commit = (push: boolean) => run(async () => {
    await Git.commit(name, { summary: summary.trim(), description: description.trim() || undefined, push }, namespace);
    setSummary("");
    setDescription("");
  });
  const canCommit = canWrite && staged.length > 0 && summary.trim() !== "" && !busy && github.data?.keySet === true;

  const list = (items: GitChange[]) => (
    <ul className="space-y-0.5">
      {items.map((change) => {
        const active = current === change;
        const slash = change.path.lastIndexOf("/");
        return (
          <li key={`${change.staged}-${change.path}`}>
            <button type="button" onClick={() => setSelected({ path: change.path, staged: change.staged, untracked: change.state === "U" })} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-foreground/5", active && "bg-accent/10")}>
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className={cn("truncate", GIT_STATE_CLASS[change.state])}>{change.path.slice(slash + 1)}</span>
              {slash > 0 && <span className="truncate text-xs text-muted">{change.path.slice(0, slash)}</span>}
              <span className={cn("ml-auto shrink-0 font-mono text-[11px] font-semibold", GIT_STATE_CLASS[change.state])}>{change.state}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
      <div className={cn("flex flex-col gap-4 rounded-xl border border-border bg-surface/50 p-3", current && "hidden lg:flex")}>
        {changes.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted">{intl.formatMessage(M.no_changes)}</p>}
        {staged.length > 0 && (
          <section className="space-y-1">
            <ListHeader title={intl.formatMessage(M.staged, { count: staged.length })}>
              <LinkButton isDisabled={!canWrite || busy} onPress={() => run(() => Git.unstage(name, "all", namespace))}>{intl.formatMessage(M.unstage_all)}</LinkButton>
            </ListHeader>
            {list(staged)}
          </section>
        )}
        {unstaged.length > 0 && (
          <section className="space-y-1">
            <ListHeader title={intl.formatMessage(M.unstaged, { count: unstaged.length })}>
              <LinkButton isDisabled={!canWrite || busy} onPress={() => setDiscard(unstaged.map((change) => change.path))}>{intl.formatMessage(M.discard_all)}</LinkButton>
              <LinkButton isDisabled={!canWrite || busy} onPress={() => run(() => Git.stage(name, "all", namespace))}>{intl.formatMessage(M.stage_all)}</LinkButton>
            </ListHeader>
            {list(unstaged)}
          </section>
        )}
        {canWrite && (
          <div className="mt-auto space-y-2 rounded-lg border border-border bg-surface p-3">
            <TextField aria-label={intl.formatMessage(M.summary)}>
              <Input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder={intl.formatMessage(M.summary)} />
            </TextField>
            <TextField aria-label={intl.formatMessage(M.description)}>
              <TextArea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={intl.formatMessage(M.description)} rows={3} />
            </TextField>
            <p className="text-[11px] text-muted">{github.data?.keySet ? intl.formatMessage(M.token_note, { login: github.data.login }) : intl.formatMessage(M.token_missing)}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" isDisabled={!canCommit} onPress={() => commit(false)}>{intl.formatMessage(M.commit, { count: staged.length })}</Button>
              {canPush && <Button variant="secondary" size="sm" isDisabled={!canCommit} onPress={() => commit(true)}>{intl.formatMessage(M.commit_push)}</Button>}
            </div>
          </div>
        )}
      </div>

      <div className={cn("min-w-0 flex-col rounded-xl border border-border bg-surface/50", current ? "flex" : "hidden lg:flex")}>
        {current ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              <Button variant="ghost" size="sm" className="lg:hidden" onPress={() => setSelected(null)}><ArrowLeft className="h-4 w-4" />{intl.formatMessage(M.back)}</Button>
              <span className="min-w-0 truncate font-mono text-sm">{current.path}</span>
              <span className="font-mono text-xs text-success">{intl.formatMessage(LINE_COUNT.added, { count: current.additions })}</span>
              <span className="font-mono text-xs text-danger">{intl.formatMessage(LINE_COUNT.removed, { count: current.deletions })}</span>
              <div className="ml-auto flex gap-2">
                <Button variant="secondary" size="sm" isDisabled={!canWrite || busy} onPress={() => run(() => (current.staged ? Git.unstage : Git.stage)(name, [current.path], namespace))}>
                  {intl.formatMessage(current.staged ? M.unstage_file : M.stage_file)}
                </Button>
                {!current.staged && (
                  <Button variant="danger" size="sm" isDisabled={!canWrite || busy} onPress={() => setDiscard([current.path])}>
                    <RotateCcw className="h-4 w-4" />{intl.formatMessage(M.discard)}
                  </Button>
                )}
              </div>
            </div>
            <FileDiff repository={repository} target={target} change={current} />
          </>
        ) : (
          <p className="m-auto p-10 text-sm text-muted">{intl.formatMessage(M.select_file)}</p>
        )}
      </div>

      {discard && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDiscard(null)}
          title={intl.formatMessage(M.discard_title, { target: discard.length === 1 ? discard[0] : intl.formatMessage(M.all_changes) })}
          description={intl.formatMessage(M.discard_body)}
          destructive
          confirmLabel={intl.formatMessage(M.discard)}
          busy={busy}
          onConfirm={() => {
            run(() => Git.discard(name, discard, namespace));
            setDiscard(null);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

const LINE_COUNT: Record<"added" | "removed", MessageDescriptor> = defineMessages({
  added: { id: "web.repositories.git.lines_added", defaultMessage: "+{count}", description: "Git tab: number of added lines; {count} is the number" },
  removed: { id: "web.repositories.git.lines_removed", defaultMessage: "-{count}", description: "Git tab: number of removed lines; {count} is the number" },
});

function FileDiff({ repository, target, change }: { repository: Repository; target: ResourceTarget; change: GitChange }) {
  const client = useResourceClient(target);
  const { name, namespace } = repository;
  const untracked = change.state === "U";
  const diff = useQuery({
    queryKey: resourceKey(target, "git-diff", change.path, change.staged, change.additions, change.deletions),
    queryFn: async () => untracked
      ? (await client.Files.read(name, `/${change.path}`, namespace)).split("\n").map((line) => `+${line}`).join("\n")
      : Git.diff(name, change.path, change.staged, namespace),
  });
  return <DiffBody text={diff.data} error={diff.error} />;
}

function DiffBody({ text, error }: { text?: string; error: unknown }) {
  const intl = useOptionalIntl();
  if (error) return <div className="p-3"><ErrorBanner err={gitErrorText(intl, error)} /></div>;
  if (text === undefined) return <div className="grid flex-1 place-items-center p-10"><Loader2 className="h-5 w-5 animate-spin text-muted" /></div>;
  return (
    <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-5 scrollbar-thin">
      {text.split("\n").map((line, index) => (
        <div key={index} className={cn("min-h-5 whitespace-pre", diffLineClass(line))}>{line}</div>
      ))}
    </pre>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("diff --git")) return "mt-3 font-semibold text-foreground first:mt-0";
  if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) return "text-muted";
  if (line.startsWith("@@")) return "text-muted";
  if (line.startsWith("+")) return "rounded-sm bg-success/10 px-1 text-success";
  if (line.startsWith("-")) return "rounded-sm bg-danger/10 px-1 text-danger";
  return "px-1 text-foreground";
}

function HistoryView({ repository, target, upstream, behind, busy, run, canWrite }: ActionProps & { upstream: string | null; behind: number }) {
  const intl = useOptionalIntl();
  const { name, namespace } = repository;
  const [selected, setSelected] = useState<string | null>(null);
  const local = useQuery({ queryKey: resourceKey(target, "git-log", "HEAD"), queryFn: ({ signal }) => Git.log(name, "HEAD", namespace, signal) });
  const remote = useQuery({ queryKey: resourceKey(target, "git-log", upstream), queryFn: ({ signal }) => Git.log(name, upstream ?? "", namespace, signal), enabled: !!upstream });
  const detail = useQuery({ queryKey: resourceKey(target, "git-commit", selected), queryFn: ({ signal }) => Git.show(name, selected ?? "", namespace, signal), enabled: !!selected });
  const notPushed = (local.data?.commits ?? []).filter((commit) => !commit.pushed);
  const published = upstream ? remote.data?.commits ?? [] : (local.data?.commits ?? []).filter((commit) => commit.pushed);
  const shown = detail.data;
  const files = shown ? shown.diff.split("\n").filter((line) => line.startsWith("diff --git")).length : 0;

  const list = (commits: GitCommit[]) => (
    <ul className="space-y-0.5">
      {commits.map((commit) => (
        <li key={commit.sha}>
          <button type="button" onClick={() => setSelected(commit.sha)} className={cn("w-full rounded-md px-2 py-1.5 text-left hover:bg-foreground/5", selected === commit.sha && "bg-accent/10")}>
            <div className="truncate text-[13px]">{commit.subject}</div>
            <div className="truncate text-xs text-muted">{intl.formatMessage(M.commit_row, { author: author(intl, commit), when: formatRelative(commit.time, intl), sha: commit.sha.slice(0, 7) })}</div>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
      <div className={cn("flex flex-col gap-4 rounded-xl border border-border bg-surface/50 p-3", selected && "hidden lg:flex")}>
        {notPushed.length > 0 && (
          <section className="space-y-1">
            <ListHeader title={intl.formatMessage(M.not_pushed, { count: notPushed.length })}>
              <LinkButton isDisabled={!canWrite || busy} onPress={() => run(() => Git.undo(name, namespace))}><Undo2 className="h-3 w-3" />{intl.formatMessage(M.undo)}</LinkButton>
            </ListHeader>
            {list(notPushed)}
          </section>
        )}
        <section className="space-y-1">
          <ListHeader title={upstream ?? repository.branch}>
            {behind > 0 && <span className="text-xs text-accent">{intl.formatMessage(M.to_pull, { count: behind })}</span>}
          </ListHeader>
          {list(published)}
        </section>
      </div>

      <div className={cn("min-w-0 flex-col rounded-xl border border-border bg-surface/50", selected ? "flex" : "hidden lg:flex")}>
        {selected ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              <Button variant="ghost" size="sm" className="lg:hidden" onPress={() => setSelected(null)}><ArrowLeft className="h-4 w-4" />{intl.formatMessage(M.history)}</Button>
              <span className="font-mono text-sm">{selected.slice(0, 7)}</span>
              {shown && <span className="min-w-0 truncate font-mono text-sm">{shown.commit.subject}</span>}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {shown && <span className="text-xs text-muted">{intl.formatMessage(M.commit_meta, { author: author(intl, shown.commit), when: formatRelative(shown.commit.time, intl), count: files })}</span>}
                <Button variant="secondary" size="sm" onPress={() => void navigator.clipboard.writeText(selected)}><Copy className="h-4 w-4" />{intl.formatMessage(M.copy_sha)}</Button>
                <Button variant="danger" size="sm" isDisabled={!canWrite || busy} onPress={() => run(() => Git.revert(name, selected, namespace))}><RotateCcw className="h-4 w-4" />{intl.formatMessage(M.revert)}</Button>
              </div>
            </div>
            <DiffBody text={shown?.diff} error={detail.error} />
          </>
        ) : (
          <p className="m-auto p-10 text-sm text-muted">{intl.formatMessage(M.select_commit)}</p>
        )}
      </div>
    </div>
  );
}

function author(intl: IntlShape, commit: GitCommit): string {
  return commit.login ? intl.formatMessage(M.login, { login: commit.login }) : commit.author;
}

function ListHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-2 text-xs text-muted">
      <span>{title}</span>
      <span className="flex items-center gap-3">{children}</span>
    </div>
  );
}

function LinkButton({ isDisabled, onPress, children }: { isDisabled?: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <button type="button" disabled={isDisabled} onClick={onPress} className="inline-flex items-center gap-1 text-xs text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50">
      {children}
    </button>
  );
}

function NewBranchDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (open: boolean) => void; onCreate: (name: string) => void }) {
  const intl = useOptionalIntl();
  const [branch, setBranch] = useState("");
  const valid = /^[A-Za-z0-9._/-]+$/.test(branch) && !branch.startsWith("-");
  const submit = () => {
    onCreate(branch);
    setBranch("");
    onOpenChange(false);
  };
  return (
    <Modal isOpen={open} onOpenChange={onOpenChange}>
      <ModalBackdrop>
        <ModalContainer>
          <ModalDialog>
            <ModalHeader><ModalHeading>{intl.formatMessage(M.new_branch)}</ModalHeading></ModalHeader>
            <ModalBody>
              <TextField>
                <Label className="text-xs">{intl.formatMessage(M.branch_name)}</Label>
                <Input autoFocus value={branch} onChange={(event) => setBranch(event.target.value)} spellCheck={false} onKeyDown={(event) => event.key === "Enter" && valid && submit()} />
              </TextField>
            </ModalBody>
            <ModalFooter className="flex justify-end gap-2">
              <Button variant="ghost" onPress={() => onOpenChange(false)}>{intl.formatMessage(M.cancel)}</Button>
              <Button variant="primary" isDisabled={!valid} onPress={submit}>{intl.formatMessage(M.create)}</Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}
