import { Input, TextArea, Button } from "@heroui/react";
import { Lock, Plus, Tag, X } from "lucide-react";
import { useState } from "react";
import { DESCRIPTION_ANNOTATION, type SectionProps } from "./types";
import { Field } from "./Field";

const DESCRIPTION_MAX = 1024;

export function GeneralSection({ draft, onChange, template }: SectionProps) {
  const annotations = draft.metadata.annotations ?? {};
  const labels = draft.metadata.labels ?? {};
  const description = annotations[DESCRIPTION_ANNOTATION] ?? "";
  const [labelDraft, setLabelDraft] = useState({ key: "", value: "" });

  const setAnnotation = (key: string, value: string | undefined) => {
    const next = { ...annotations };
    if (value && value.length > 0) next[key] = value;
    else delete next[key];
    onChange({
      ...draft,
      metadata: {
        ...draft.metadata,
        annotations: Object.keys(next).length ? next : undefined,
      },
    });
  };

  const setLabels = (next: Record<string, string>) => {
    onChange({
      ...draft,
      metadata: {
        ...draft.metadata,
        labels: Object.keys(next).length ? next : undefined,
      },
    });
  };

  const addLabel = () => {
    const key = labelDraft.key.trim();
    const value = labelDraft.value.trim();
    if (!key) return;
    setLabels({ ...labels, [key]: value });
    setLabelDraft({ key: "", value: "" });
  };

  const removeLabel = (key: string) => {
    const next = { ...labels };
    delete next[key];
    setLabels(next);
  };

  const labelEntries = Object.entries(labels);

  return (
    <div className="space-y-6">
      <Field label="Name" hint="Pinned to the GameServer UID; cannot change.">
        <LockedInput value={draft.metadata.name} />
      </Field>

      <Field label="Template">
        <LockedInput value={draft.spec.templateRef.name} />
      </Field>

      <Field label="Description" hint="Shown in the dashboard server list.">
        <TextArea
          value={description}
          onChange={(e) => setAnnotation(DESCRIPTION_ANNOTATION, e.target.value)}
          maxLength={DESCRIPTION_MAX}
          rows={3}
          placeholder="Long-standing survival realm. Invite-only."
          className="w-full resize-y"
        />
        <div className="pt-1.5 text-right text-xs tabular-nums text-muted">
          {description.length}/{DESCRIPTION_MAX}
        </div>
      </Field>

      <Field label="Image override" hint="Pin a specific game-container image. Leave blank to use the template default.">
        <Input
          value={draft.spec.image ?? ""}
          onChange={(e) =>
            onChange({
              ...draft,
              spec: { ...draft.spec, image: e.target.value || undefined },
            })
          }
          placeholder={template?.spec.image ?? "(template image)"}
          spellCheck={false}
          className="w-full font-mono text-[13px]"
        />
      </Field>

      <Field label="Labels" hint="Free-form Kubernetes labels.">
        <div className="space-y-3">
          {labelEntries.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {labelEntries.map(([key, value]) => (
                <span
                  key={key}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-default py-0.5 pl-2 pr-0.5 font-mono text-xs"
                >
                  <Tag className="h-3 w-3 text-muted" />
                  <span className="text-muted">{key}</span>
                  <span className="text-muted">=</span>
                  <span className="text-fg">{value}</span>
                  {/* The tooltip lives on a wrapping element's title (react-aria's
                      Button strips a bare `title` prop) so the button keeps its
                      aria-label as the accessible name for role queries. */}
                  <span title="Remove label">
                    <Button
                      isIconOnly
                      variant="ghost"
                      size="sm"
                      aria-label="Remove label"
                      onPress={() => removeLabel(key)}
                      className="h-6 w-6 min-w-6"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </span>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Input
              value={labelDraft.key}
              onChange={(e) => setLabelDraft({ ...labelDraft, key: e.target.value })}
              placeholder="key"
              spellCheck={false}
              className="min-w-0 flex-1 font-mono text-[13px]"
            />
            <Input
              value={labelDraft.value}
              onChange={(e) => setLabelDraft({ ...labelDraft, value: e.target.value })}
              placeholder="value"
              spellCheck={false}
              className="min-w-0 flex-1 font-mono text-[13px]"
            />
            <Button variant="outline" onPress={addLabel} isDisabled={!labelDraft.key.trim()}>
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>
        </div>
      </Field>
    </div>
  );
}

function LockedInput({ value }: { value: string }) {
  return (
    <div className="relative">
      <Input
        value={value}
        disabled
        className="w-full pr-9 font-mono text-[13px] disabled:text-muted disabled:opacity-100"
      />
      <Lock className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
    </div>
  );
}
