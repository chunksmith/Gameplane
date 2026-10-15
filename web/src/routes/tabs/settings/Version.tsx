import { AlertTriangle, Info } from "lucide-react";

import { RadioGroup, Radio, Button, Chip } from "@heroui/react";
import type { SectionProps } from "./types";

// VersionSection lets an existing server switch to another entry of the
// template's version catalog (spec.versions) — the same choice the Create
// wizard offers, post-create. Saving rides the tab's read-merge-PUT; the
// operator re-renders the StatefulSet (image/env/per-loader mod volume)
// and the pod restarts on the new version.
export function VersionSection({ draft, onChange, template }: SectionProps) {
  const versions = template?.spec.versions ?? [];
  const defaultId = versions.find((v) => v.default)?.id ?? versions[0]?.id ?? "";
  const selectedId = draft.spec.version || defaultId;
  const hasLoaderVolumes = Object.keys(
    template?.spec.capabilities?.mods?.loaders ?? {},
  ).length > 0;

  if (versions.length === 0) {
    return (
      <p className="text-sm text-muted">
        This template has no version catalog — the server always runs the
        template image{draft.spec.image ? " (currently overridden below in General)" : ""}.
      </p>
    );
  }

  const pick = (id: string) =>
    onChange({ ...draft, spec: { ...draft.spec, version: id } });

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Game version</h2>
        <p className="pt-1 text-[13px] text-muted">
          Pick a version + loader from the template&apos;s catalog. Saving
          restarts the server on the new version.
        </p>
      </div>

      <RadioGroup value={selectedId} onChange={pick} aria-label="Game version" className="space-y-2">
        {versions.map((v) => (
          <Radio key={v.id} value={v.id}>
            <Radio.Content className="flex w-full items-start gap-3 rounded-lg border border-border px-3 py-3 transition-colors hover:bg-surface/60 data-[selected]:border-primary data-[selected]:bg-primary/5">
              <Radio.Control className="shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{v.displayName}</span>
                  {v.default && (
                    <Chip size="sm" variant="soft" color="accent">
                      Default
                    </Chip>
                  )}
                </div>
                <p className="pt-0.5 text-[11px] text-muted">
                  {[
                    v.loader ? `loader ${v.loader}` : null,
                    v.gameVersion ? `game ${v.gameVersion}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || v.id}
                </p>
              </div>
            </Radio.Content>
          </Radio>
        ))}
      </RadioGroup>

      {hasLoaderVolumes && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-surface/40 px-3 py-2.5">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p className="text-xs text-muted">
            Each loader keeps its own mod volume — a loader&apos;s mods are
            preserved and restored if you switch back to it later.
          </p>
        </div>
      )}

      {draft.spec.image && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <p className="flex-1 text-xs text-muted">
            Image override active (<code className="font-mono">{draft.spec.image}</code>)
            — the selected version&apos;s image is ignored until cleared.
          </p>
          <Button
            variant="outline"
            size="sm"
            onPress={() =>
              onChange({ ...draft, spec: { ...draft.spec, image: undefined } })
            }
          >
            Clear override
          </Button>
        </div>
      )}

      <p className="text-[11px] text-muted">
        Downgrading across game versions may be unsupported by the game&apos;s
        world data — take a backup first.
      </p>
    </div>
  );
}
