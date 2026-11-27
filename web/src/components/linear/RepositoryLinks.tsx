import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, ListBox, ListBoxItem, Select } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { Link2 } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useOptionalIntl } from "@/lib/i18n/format";
import { Linear, LINEAR_KEY } from "@/lib/linear";
import { Repositories, REPOSITORIES_KEY } from "@/lib/repositories";
import type { LinearRepoLink } from "@/types";

const NONE = "none";

const MESSAGES: Record<string, MessageDescriptor> = defineMessages({
  title: { id: "web.linear.links_title", defaultMessage: "Repository links", description: "Linear: heading of the repository links table" },
  hint: { id: "web.linear.links_hint", defaultMessage: "Each Linear project opens its issues in the repository you pick here. Solving an issue preselects it.", description: "Linear: hint under the repository links heading explaining what a link does" },
  project: { id: "web.linear.links_project", defaultMessage: "Linear project", description: "Linear: column heading of the Linear project names in the repository links table" },
  repository: { id: "web.linear.links_repository", defaultMessage: "Repository", description: "Linear: column heading of the repository select in the repository links table" },
  pick: { id: "web.linear.links_pick", defaultMessage: "Repository for {project}", description: "Linear: accessible name of the repository select on a project row; {project} is the Linear project name" },
  none: { id: "web.linear.links_none", defaultMessage: "No repository", description: "Linear: option that removes the repository link of a project" },
  option: { id: "web.linear.links_option", defaultMessage: "{name} · {namespace}", description: "Linear: repository option in the repository links table; {name} is the repository name, {namespace} the Kubernetes namespace" },
  save: { id: "web.linear.links_save", defaultMessage: "Save links", description: "Linear: button that saves the project to repository links" },
  saved: { id: "web.linear.links_saved", defaultMessage: "Links saved.", description: "Linear: confirmation under the repository links table after a successful save" },
  emptyTitle: { id: "web.linear.links_empty_title", defaultMessage: "No Linear projects", description: "Linear: empty state title of the repository links table when Linear has no projects" },
  emptyHint: { id: "web.linear.links_empty_hint", defaultMessage: "Projects you can see in Linear appear here.", description: "Linear: empty state hint of the repository links table" },
});

const keyOf = (namespace: string, name: string) => `${namespace}/${name}`;

export function RepositoryLinks() {
  const intl = useOptionalIntl();
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: [...LINEAR_KEY, "projects"], queryFn: () => Linear.projects() });
  const links = useQuery({ queryKey: [...LINEAR_KEY, "links"], queryFn: () => Linear.links() });
  const repositories = useQuery({ queryKey: REPOSITORIES_KEY, queryFn: () => Repositories.list() });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const saved = Object.fromEntries((links.data ?? []).map((link) => [link.projectId, keyOf(link.namespace, link.repository)]));
  const current = { ...saved, ...draft };
  const save = useMutation({
    mutationFn: (rows: LinearRepoLink[]) => Linear.putLinks(rows),
    onSuccess: () => {
      setDraft({});
      void qc.invalidateQueries({ queryKey: LINEAR_KEY });
    },
  });

  function submit() {
    const rows = new Map((links.data ?? []).map((link) => [link.projectId, link]));
    for (const project of projects.data ?? []) {
      const choice = draft[project.id];
      if (choice === undefined) continue;
      if (choice === NONE) {
        rows.delete(project.id);
        continue;
      }
      const repo = repositories.data?.find((item) => keyOf(item.namespace, item.name) === choice);
      if (repo) rows.set(project.id, { projectId: project.id, projectName: project.name, repository: repo.name, namespace: repo.namespace });
    }
    save.mutate([...rows.values()]);
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">{intl.formatMessage(MESSAGES.title)}</h2>
        <p className="text-xs text-muted">{intl.formatMessage(MESSAGES.hint)}</p>
      </header>
      {projects.error && <ErrorBanner err={projects.error} />}
      {links.error && <ErrorBanner err={links.error} />}
      {projects.data?.length === 0 && <EmptyState icon={<Link2 />} title={intl.formatMessage(MESSAGES.emptyTitle)} hint={intl.formatMessage(MESSAGES.emptyHint)} />}
      {projects.data && projects.data.length > 0 && (
        <div className="flex flex-col divide-y divide-border">
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 pb-2 text-xs uppercase tracking-wide text-muted sm:grid">
            <span>{intl.formatMessage(MESSAGES.project)}</span>
            <span>{intl.formatMessage(MESSAGES.repository)}</span>
          </div>
          {projects.data.map((project) => (
            <div key={project.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center sm:gap-3">
              <span className="truncate text-sm">{project.name}</span>
              <Select aria-label={intl.formatMessage(MESSAGES.pick, { project: project.name })} value={current[project.id] ?? NONE} onChange={(next) => setDraft({ ...draft, [project.id]: String(next ?? NONE) })} className="w-full">
                <Select.Trigger className="w-full items-center rounded border border-border bg-surface px-3 py-2 text-sm">
                  <Select.Value />
                  <Select.Indicator className="ml-auto h-4 w-4" />
                </Select.Trigger>
                <Select.Popover className="rounded border border-border">
                  <ListBox className="p-0">
                    <ListBoxItem id={NONE} textValue={intl.formatMessage(MESSAGES.none)}>{intl.formatMessage(MESSAGES.none)}</ListBoxItem>
                    {repositories.data?.map((item) => {
                      const label = intl.formatMessage(MESSAGES.option, { name: item.name, namespace: item.namespace });
                      return <ListBoxItem key={keyOf(item.namespace, item.name)} id={keyOf(item.namespace, item.name)} textValue={label}>{label}</ListBoxItem>;
                    })}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
          ))}
        </div>
      )}
      {save.error && <ErrorBanner err={save.error} />}
      <footer className="flex items-center justify-end gap-3">
        {save.isSuccess && <span role="status" className="text-xs text-success">{intl.formatMessage(MESSAGES.saved)}</span>}
        <Button variant="primary" onPress={submit} isDisabled={save.isPending || !projects.data}>{intl.formatMessage(MESSAGES.save)}</Button>
      </footer>
    </section>
  );
}
