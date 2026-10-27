import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  Description,
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
  TextField,
} from "@heroui/react";
import { defineMessages } from "react-intl";
import { ArrowRight, FolderGit2, Plus, Search } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingCard } from "@/components/ui/LoadingCard";
import { can, useMe } from "@/lib/auth";
import { Networks } from "@/lib/endpoints";
import { busyPhase, gitErrorText, initials, repoSlug, Repositories, REPOSITORIES_KEY, useGitHub } from "@/lib/repositories";
import { isValidK8sName } from "@/lib/validation";
import { useOptionalIntl } from "@/lib/i18n/format";
import { cn, formatRelative } from "@/lib/utils";
import type { Repository } from "@/types";

const chipClass = "inline-flex items-center rounded-md bg-foreground/5 px-2 py-0.5 text-xs text-foreground";

export function RepositoriesPage() {
  const intl = useOptionalIntl();
  const { data: me } = useMe();
  const github = useGitHub();
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: REPOSITORIES_KEY,
    queryFn: ({ signal }) => Repositories.list(signal),
    refetchInterval: (query) => (query.state.data?.some(busyPhase) ? 3_000 : false),
  });
  const needle = search.trim().toLowerCase();
  const shown = (list.data ?? []).filter((repository) => !needle || repository.name.includes(needle) || repository.url.toLowerCase().includes(needle));

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title={intl.formatMessage({ id: "web.repositories.title", defaultMessage: "Repositories", description: "Repositories: page title" })}
          description={intl.formatMessage({ id: "web.repositories.subtitle", defaultMessage: "Git repositories your team edits, commits and pushes from the panel.", description: "Repositories: description under the page title" })}
        />
        {github.data?.keySet ? (
          <span className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-success">
            <span className="h-2 w-2 rounded-full bg-current" />
            {intl.formatMessage({ id: "web.repositories.github_connected", defaultMessage: "GitHub · @{login}", description: "Repositories: chip in the page header showing the connected GitHub account; {login} is the GitHub login" }, { login: github.data.login })}
          </span>
        ) : (
          <Link to="/settings/integrations" className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-foreground">
            {intl.formatMessage({ id: "web.repositories.connect_github", defaultMessage: "Connect GitHub", description: "Repositories: link in the page header to Settings, Integrations when no GitHub token is connected" })}
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/60" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full pl-9"
            placeholder={intl.formatMessage({ id: "web.repositories.search", defaultMessage: "Search repositories…", description: "Repositories: placeholder of the search box above the repository cards" })}
            aria-label={intl.formatMessage({ id: "web.repositories.search_label", defaultMessage: "Search repositories", description: "Repositories: accessible name of the search box; not shown on screen" })}
          />
        </div>
        {can(me, "repositories:create") && (
          <Button variant="primary" className="rounded-full" onPress={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            {intl.formatMessage({ id: "web.repositories.add", defaultMessage: "Add repository", description: "Repositories: button that opens the Add repository dialog, and the dialog title; keep it short" })}
          </Button>
        )}
      </div>

      {list.error ? (
        <ErrorBanner err={list.error} />
      ) : !list.data ? (
        <LoadingCard message={intl.formatMessage({ id: "web.repositories.loading", defaultMessage: "Loading repositories…", description: "Repositories: loading text while the repository list is fetched" })} />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<FolderGit2 />}
          title={intl.formatMessage({ id: "web.repositories.empty", defaultMessage: "No repositories yet", description: "Repositories: title of the empty state when the user can see no repositories" })}
          hint={intl.formatMessage({ id: "web.repositories.empty_hint", defaultMessage: "Repositories you own, collaborate on or reach through a network appear here.", description: "Repositories: hint under the empty state title" })}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((repository) => (
            <RepositoryCard key={`${repository.namespace}/${repository.name}`} repository={repository} meId={me?.id} />
          ))}
        </div>
      )}

      <AddRepositoryDialog open={adding} onOpenChange={setAdding} tokenSet={github.data?.keySet === true} />
    </div>
  );
}

function RepositoryCard({ repository, meId }: { repository: Repository; meId?: number }) {
  const intl = useOptionalIntl();
  const cloning = busyPhase(repository);
  const members = repository.collaborators === 0 && repository.owner.id === String(meId)
    ? intl.formatMessage({ id: "web.repositories.only_you", defaultMessage: "Only you", description: "Repositories: card footer when the user is the owner and there are no collaborators" })
    : intl.formatMessage({ id: "web.repositories.members", defaultMessage: "{count, plural, one {# member} other {# members}}", description: "Repositories: card footer with the number of people with access; {count} is the owner plus collaborators" }, { count: repository.collaborators + 1 });
  return (
    <Card className="border border-border">
      <Card.Content className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <RepositoryAvatar name={repository.name} />
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{repository.name}</div>
            <div className="truncate text-xs text-muted">
              {cloning
                ? intl.formatMessage({ id: "web.repositories.slug_cloning", defaultMessage: "{slug} · Cloning… {progress}%", description: "Repositories: card subtitle while the repository is cloning; {slug} is owner/repo and {progress} the clone progress" }, { slug: repoSlug(repository.url), progress: repository.cloneProgress ?? 0 })
                : intl.formatMessage({ id: "web.repositories.slug_branch", defaultMessage: "{slug} · {branch}", description: "Repositories: card subtitle; {slug} is owner/repo and {branch} the branch" }, { slug: repoSlug(repository.url), branch: repository.branch || intl.formatMessage(DEFAULT_BRANCH) })}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <RepositoryChips repository={repository} />
        </div>
        <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-muted">
          <span>
            {repository.lastFetch
              ? intl.formatMessage({ id: "web.repositories.members_fetched", defaultMessage: "{members} · fetched {when}", description: "Repositories: card footer with the member text and the last fetch time; {members} is the member text and {when} a relative time" }, { members, when: formatRelative(repository.lastFetch, intl) })
              : members}
          </span>
          <Link to="/repositories/$name" params={{ name: repository.name }} search={{ ns: repository.namespace }} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
            {intl.formatMessage({ id: "web.repositories.open", defaultMessage: "Open", description: "Repositories: link on a repository card that opens it; keep it short" })}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </Card.Content>
    </Card>
  );
}

const { DEFAULT_BRANCH } = defineMessages({
  DEFAULT_BRANCH: { id: "web.repositories.default_branch", defaultMessage: "default branch", description: "Repositories: shown instead of a branch name when the repository uses the remote's default branch" },
});

export function RepositoryChips({ repository }: { repository: Repository }) {
  const intl = useOptionalIntl();
  if (repository.phase === "Failed") {
    return <span className={cn(chipClass, "bg-danger/10 text-danger")}>{intl.formatMessage({ id: "web.repositories.failed", defaultMessage: "Clone failed", description: "Repositories: chip on a repository whose clone failed" })}</span>;
  }
  if (busyPhase(repository)) {
    return <span className={cn(chipClass, "bg-accent/10 text-accent")}>{repository.phase === "Cloning" ? intl.formatMessage({ id: "web.repositories.cloning", defaultMessage: "Cloning", description: "Repositories: chip on a repository that is being cloned" }) : intl.formatMessage({ id: "web.repositories.pending", defaultMessage: "Starting", description: "Repositories: chip on a repository whose agent is still starting" })}</span>;
  }
  return (
    <>
      <span className={chipClass}>
        {repository.changes > 0
          ? intl.formatMessage({ id: "web.repositories.changes", defaultMessage: "{count, plural, one {# change} other {# changes}}", description: "Repositories: chip with the number of uncommitted changes; {count} is the number" }, { count: repository.changes })
          : intl.formatMessage({ id: "web.repositories.clean", defaultMessage: "Clean", description: "Repositories: chip on a repository with no uncommitted changes" })}
      </span>
      <span className={chipClass}><AheadBehind ahead={repository.ahead} behind={repository.behind} /></span>
      {repository.network && (
        <span className={chipClass}>{intl.formatMessage({ id: "web.repositories.network_chip", defaultMessage: "network: {network}", description: "Repositories: chip naming the repository's network; {network} is the network name" }, { network: repository.network })}</span>
      )}
    </>
  );
}

export function AheadBehind({ ahead, behind }: { ahead: number; behind: number }) {
  const intl = useOptionalIntl();
  return ahead === 0 && behind === 0
    ? intl.formatMessage({ id: "web.repositories.up_to_date", defaultMessage: "up to date", description: "Repositories: shown when the branch has nothing to pull or push" })
    : intl.formatMessage({ id: "web.repositories.ahead_behind", defaultMessage: "↓{behind} ↑{ahead}", description: "Repositories: commits to pull (down arrow) and to push (up arrow); {behind} and {ahead} are numbers" }, { behind, ahead });
}

export function RepositoryAvatar({ name, large }: { name: string; large?: boolean }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-lg bg-accent/10 font-mono font-semibold text-accent", large ? "h-[72px] w-[72px] rounded-full text-2xl" : "h-10 w-10 text-xs")}>
      {initials(name)}
    </span>
  );
}

function nameFromURL(url: string): string {
  const last = url.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? "";
  return last.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

function AddRepositoryDialog({ open, onOpenChange, tokenSet }: { open: boolean; onOpenChange: (open: boolean) => void; tokenSet: boolean }) {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [url, setURL] = useState("");
  const [branch, setBranch] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [network, setNetwork] = useState("");
  const [size, setSize] = useState("2Gi");
  const networks = useQuery({ queryKey: ["networks"], queryFn: Networks.list, enabled: open, retry: false });
  const repositoryName = nameTouched ? name : nameFromURL(url);
  const urlValid = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(url.trim());
  const nameValid = isValidK8sName(repositoryName);
  const create = useMutation({
    mutationFn: () => Repositories.create({ url: url.trim(), branch: branch.trim() || undefined, name: repositoryName, network: network || undefined, storageSize: size.trim() || undefined }),
    onSuccess: async (created) => {
      await qc.invalidateQueries({ queryKey: REPOSITORIES_KEY });
      onOpenChange(false);
      await navigate({ to: "/repositories/$name", params: { name: created.name }, search: { ns: created.namespace } });
    },
  });

  return (
    <Modal isOpen={open} onOpenChange={onOpenChange}>
      <ModalBackdrop isDismissable={!create.isPending}>
        <ModalContainer>
          <ModalDialog className="sm:max-w-xl">
            <ModalHeader>
              <ModalHeading>{intl.formatMessage({ id: "web.repositories.add", defaultMessage: "Add repository", description: "Repositories: button that opens the Add repository dialog, and the dialog title; keep it short" })}</ModalHeading>
              <Description className="text-sm text-muted">{intl.formatMessage({ id: "web.repositories.add_description", defaultMessage: "Clone a GitHub repository into the panel. Everyone with access shares one copy.", description: "Add repository dialog: explanation under the title" })}</Description>
            </ModalHeader>
            <ModalBody className="grid gap-4 sm:grid-cols-2">
              <TextField className="sm:col-span-2" isInvalid={url !== "" && !urlValid}>
                <Label className="text-xs">{intl.formatMessage({ id: "web.repositories.url", defaultMessage: "Repository URL", description: "Add repository dialog: label of the repository URL field" })}</Label>
                <Input autoFocus value={url} onChange={(event) => setURL(event.target.value)} spellCheck={false} placeholder={intl.formatMessage({ id: "web.repositories.url_placeholder", defaultMessage: "https://github.com/owner/repository", description: "Add repository dialog: example value in the empty URL field" })} />
                <Description className="text-xs text-muted">{intl.formatMessage({ id: "web.repositories.url_hint", defaultMessage: "HTTPS only. Private repositories need a token with repo access.", description: "Add repository dialog: hint under the URL field" })}</Description>
              </TextField>
              <TextField>
                <Label className="text-xs">{intl.formatMessage({ id: "web.repositories.branch", defaultMessage: "Branch", description: "Add repository dialog: label of the branch field" })}</Label>
                <Input value={branch} onChange={(event) => setBranch(event.target.value)} spellCheck={false} />
                <Description className="text-xs text-muted">{intl.formatMessage({ id: "web.repositories.branch_hint", defaultMessage: "Empty uses the default branch.", description: "Add repository dialog: hint under the branch field" })}</Description>
              </TextField>
              <TextField isInvalid={repositoryName !== "" && !nameValid}>
                <Label className="text-xs">{intl.formatMessage({ id: "web.repositories.name", defaultMessage: "Name", description: "Add repository dialog: label of the repository name field" })}</Label>
                <Input value={repositoryName} onChange={(event) => { setNameTouched(true); setName(event.target.value); }} spellCheck={false} />
                <Description className="text-xs text-muted">{intl.formatMessage({ id: "web.repositories.name_hint", defaultMessage: "Lowercase letters, digits and dashes.", description: "Add repository dialog: hint under the name field" })}</Description>
              </TextField>
              {networks.data && (
                <div className="space-y-1.5">
                  <Select
                    placeholder={intl.formatMessage({ id: "web.repositories.no_network", defaultMessage: "No network", description: "Add repository dialog: network select option and placeholder for no network" })}
                    value={network}
                    onChange={(value) => setNetwork(String(value ?? ""))}
                  >
                    <Label className="text-xs">{intl.formatMessage({ id: "web.repositories.network", defaultMessage: "Network", description: "Add repository dialog: label of the network select; also the Settings network section label" })}</Label>
                    <Select.Trigger className="w-full items-center rounded border border-border bg-surface px-3 py-2 text-sm">
                      <Select.Value />
                      <Select.Indicator className="ml-auto h-4 w-4" />
                    </Select.Trigger>
                    <Select.Popover className="rounded border border-border">
                      <ListBox className="p-0">
                        {networks.data.map((item) => <ListBoxItem key={item.name} id={item.name}>{item.name}</ListBoxItem>)}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                  <p className="text-xs text-muted">{intl.formatMessage({ id: "web.repositories.network_hint", defaultMessage: "Network members can edit and push.", description: "Add repository dialog: hint under the network select" })}</p>
                </div>
              )}
              <TextField>
                <Label className="text-xs">{intl.formatMessage({ id: "web.repositories.disk_size", defaultMessage: "Disk size", description: "Add repository dialog: label of the disk size field" })}</Label>
                <Input value={size} onChange={(event) => setSize(event.target.value)} spellCheck={false} />
                <Description className="text-xs text-muted">{intl.formatMessage({ id: "web.repositories.disk_hint", defaultMessage: "Volume for the working copy.", description: "Add repository dialog: hint under the disk size field" })}</Description>
              </TextField>
              <div className="rounded-lg bg-accent/10 p-3 sm:col-span-2">
                <div className="text-sm font-medium text-accent">{intl.formatMessage({ id: "web.repositories.token_note_title", defaultMessage: "Uses your GitHub token", description: "Add repository dialog: title of the note about whose token is used" })}</div>
                <p className="text-xs text-muted">{tokenSet
                  ? intl.formatMessage({ id: "web.repositories.token_note", defaultMessage: "The clone runs with your token. Later, every pull, fetch and push runs with the token of the person who starts it, so GitHub shows who did what.", description: "Add repository dialog: note explaining that each Git network operation uses the acting user's own token" })
                  : intl.formatMessage({ id: "web.repositories.token_missing", defaultMessage: "Connect your GitHub token in Settings, Integrations before adding a repository.", description: "Add repository dialog: note shown instead when the user has no GitHub token yet" })}</p>
              </div>
              {create.error && <p role="alert" className="text-xs text-danger sm:col-span-2">{gitErrorText(intl, create.error)}</p>}
            </ModalBody>
            <ModalFooter className="flex justify-end gap-2">
              <Button variant="ghost" onPress={() => onOpenChange(false)} isDisabled={create.isPending}>{intl.formatMessage({ id: "web.repositories.cancel", defaultMessage: "Cancel", description: "Repositories: button that closes a dialog without changes" })}</Button>
              <Button variant="primary" isDisabled={!tokenSet || !urlValid || !nameValid} isPending={create.isPending} onPress={() => create.mutate()}>
                {intl.formatMessage({ id: "web.repositories.clone", defaultMessage: "Clone repository", description: "Add repository dialog: submit button that adds and clones the repository" })}
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}
