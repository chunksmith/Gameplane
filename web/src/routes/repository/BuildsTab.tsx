import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { Eraser, Hammer, Play, RefreshCw } from "lucide-react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { EmptyState } from "@/components/ui/EmptyState";
import { useFormat, useOptionalIntl } from "@/lib/i18n/format";
import { Builds, buildsKey, gitErrorText, isActiveBuild, useBuilds } from "@/lib/repositories";
import { formatRelative, cn } from "@/lib/utils";
import type { Build, BuildStart, Repository } from "@/types";
import { BuildDetail } from "./BuildDetail";
import { buildTitle, durationLabel, durationSeconds, joinDot, phaseTone, sizeLabel, sourceLabel, starterLabel, toolLabel, useNow } from "./buildUi";

const M: Record<string, MessageDescriptor> = defineMessages({
  title: { id: "web.repositories.builds.tab_title", defaultMessage: "Builds", description: "Builds tab: heading of the build list card" },
  keeps: { id: "web.repositories.builds.keeps", defaultMessage: "Keeps the last {keep}", description: "Builds tab: note in the build list header with how many builds are kept; {keep} is the number" },
  count: { id: "web.repositories.builds.count", defaultMessage: "{count, plural, one {# build} other {# builds}}", description: "Builds tab: number of builds in the list; {count} is the number" },
  jdk: { id: "web.repositories.builds.jdk", defaultMessage: "JDK {version}", description: "Builds tab: Java version a build runs with; {version} is 17, 21 or 25" },  cache: { id: "web.repositories.builds.cache", defaultMessage: "cache {size}", description: "Builds tab: size of the build cache; {size} is the formatted size" },
  node: { id: "web.repositories.builds.node", defaultMessage: "builds run on this repository's node", description: "Builds tab: note next to the toolbar that builds run on the node holding the repository" },
  refresh: { id: "web.repositories.builds.refresh", defaultMessage: "Refresh builds", description: "Builds tab: accessible name of the icon button that reloads the build list" },
  clear_cache: { id: "web.repositories.builds.clear_cache", defaultMessage: "Clear cache", description: "Builds tab: button that empties the build cache; keep it short" },
  build: { id: "web.repositories.builds.build", defaultMessage: "Build", description: "Builds tab: button that starts a new build; keep it short" },
  empty: { id: "web.repositories.builds.empty", defaultMessage: "No builds yet. Start one to compile this repository.", description: "Builds tab: empty state when the repository has no builds" },
  hint_failed: { id: "web.repositories.builds.hint_failed", defaultMessage: "Failed", description: "Builds tab: label of a failed build in the list when it has no message; keep it short" },
  jars: { id: "web.repositories.builds.jars", defaultMessage: "{count, plural, one {# jar} other {# jars}}", description: "Builds tab: number of jar artifacts a build produced; {count} is the number" },
});

interface BuildsTabProps {
  repository: Repository;
  canWrite: boolean;
  onAskAssistant: (prompt: string) => void;
}

export function BuildsTab({ repository, canWrite, onAskAssistant }: BuildsTabProps) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const qc = useQueryClient();
  const { name, namespace } = repository;
  const list = useBuilds(name, namespace);
  const [picked, setPicked] = useState<number | null>(null);
  const builds = list.data?.builds ?? [];
  const current = builds.find((build) => build.number === picked) ?? builds[0];
  const active = builds.some((build) => isActiveBuild(build.phase));
  const now = useNow(active);
  const refresh = () => qc.invalidateQueries({ queryKey: buildsKey(namespace, name) });
  const start = useMutation({
    mutationFn: (body: BuildStart) => Builds.start(name, body, namespace),
    onSuccess: async (build) => { setPicked(build.number); await refresh(); },
  });
  const remove = useMutation({
    mutationFn: (number: number) => Builds.remove(name, number, namespace),
    onSuccess: async () => { setPicked(null); await refresh(); },
  });
  const clear = useMutation({ mutationFn: () => Builds.clearCache(name, namespace), onSuccess: refresh });
  const errorText = (error: unknown) => (error ? gitErrorText(intl, error) : null);
  const failure = errorText(start.error) ?? errorText(remove.error) ?? errorText(clear.error);
  const settings = list.data?.settings;
  const open = picked !== null;

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {settings && (
          <p className="min-w-0 text-xs text-muted">
            {joinDot(intl, [
              toolLabel(intl, settings.tool === "auto" ? (settings.detected ?? "auto") : settings.tool),
              intl.formatMessage(M.jdk, { version: settings.jdk }),
              settings.args,
              list.data?.cacheBytes != null && intl.formatMessage(M.cache, { size: sizeLabel(intl, format, list.data.cacheBytes) }),
              intl.formatMessage(M.node),
            ])}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button isIconOnly variant="ghost" size="sm" aria-label={intl.formatMessage(M.refresh)} onPress={() => void list.refetch()} isDisabled={list.isFetching}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          {canWrite && (
            <Button variant="outline" size="sm" className="rounded-full" isDisabled={active || clear.isPending} onPress={() => clear.mutate()}>
              <Eraser className="h-4 w-4" />{intl.formatMessage(M.clear_cache)}
            </Button>
          )}
          {canWrite && (
            <Button variant="primary" size="sm" className="rounded-full" isDisabled={active || start.isPending} onPress={() => start.mutate({})}>
              <Play className="h-4 w-4" />{intl.formatMessage(M.build)}
            </Button>
          )}
        </div>
      </div>
      {failure && <ErrorBanner err={failure} onDismiss={() => { start.reset(); remove.reset(); clear.reset(); }} />}

      {builds.length === 0 ? (
        <Card className="border border-border">
          <EmptyState icon={<Hammer />} title={intl.formatMessage(M.empty)} />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
          <Card className={cn("h-fit border border-border", open && "hidden lg:flex")}>
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 text-xs text-muted">
              <span className="font-medium text-foreground">{joinDot(intl, [intl.formatMessage(M.title), intl.formatMessage(M.count, { count: builds.length })])}</span>
              {list.data && <span>{intl.formatMessage(M.keeps, { keep: list.data.keep })}</span>}
            </div>
            <ul className="divide-y divide-border">
              {builds.map((build) => (
                <BuildRow key={build.number} build={build} selected={current?.number === build.number} now={now} onSelect={() => setPicked(build.number)} />
              ))}
            </ul>
          </Card>
          <div className={cn("min-w-0", !open && "hidden lg:block")}>
            {current && (
              <BuildDetail
                repository={repository}
                build={current}
                canWrite={canWrite}
                now={now}
                busy={start.isPending || remove.isPending}
                onBack={() => setPicked(null)}
                onRebuild={(build: Build) => start.mutate({ tool: build.tool, jdk: build.jdk, args: build.args })}
                onCancel={(build: Build) => remove.mutate(build.number)}
                onAskAssistant={onAskAssistant}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BuildRow({ build, selected, now, onSelect }: { build: Build; selected: boolean; now: number; onSelect: () => void }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const seconds = durationSeconds(build, now);
  const detail = build.phase === "Failed"
    ? build.message || intl.formatMessage(M.hint_failed)
    : intl.formatMessage(M.jars, { count: build.artifacts.length });
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn("flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-default/40", selected && "bg-accent/10")}
      >
        <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", phaseTone(build.phase))} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{buildTitle(intl, build)}</span>
          <span className="block truncate text-xs text-muted">
            {joinDot(intl, [sourceLabel(intl, build), starterLabel(intl, build), detail])}
          </span>
        </span>
        <span className="shrink-0 text-right text-xs text-muted">
          <span className="block font-mono">{durationLabel(intl, format, seconds)}</span>
          <span className="block">{formatRelative(build.createdAt, intl)}</span>
        </span>
      </button>
    </li>
  );
}
