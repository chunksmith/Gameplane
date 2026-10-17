import { Input, TextArea, Button } from "@heroui/react";
import { Lock, Plus, Tag, X } from "lucide-react";
import { useState } from "react";
import { DESCRIPTION_ANNOTATION, type SectionProps } from "./types";
import { Field } from "./Field";
import { useOptionalIntl } from "@/lib/i18n/format";

const DESCRIPTION_MAX = 1024;

export function GeneralSection({ draft, onChange, template }: SectionProps) {
  const intl = useOptionalIntl();
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
      <Field label={intl.formatMessage({ id: "web.routes.tabs.settings.general.name", defaultMessage: "Name", description: "General: field label for the server name, which is fixed and cannot be edited here" })} hint={intl.formatMessage({ id: "web.routes.tabs.settings.general.pinned_to_the_gameserver_uid_cannot", defaultMessage: "Pinned to the GameServer UID; cannot change.", description: "General: hint under the server name field saying the name is pinned to the game server's unique ID and cannot be changed" })}>
        <LockedInput value={draft.metadata.name} />
      </Field>

      <Field label={intl.formatMessage({ id: "web.routes.tabs.settings.general.template", defaultMessage: "Template", description: "General: field label for the game template the server was created from; the field is read-only" })}>
        <LockedInput value={draft.spec.templateRef.name} />
      </Field>

      <Field label={intl.formatMessage({ id: "web.routes.tabs.settings.general.description", defaultMessage: "Description", description: "General: field label for the free-text description of the server" })} hint={intl.formatMessage({ id: "web.routes.tabs.settings.general.shown_in_the_dashboard_server_list", defaultMessage: "Shown in the dashboard server list.", description: "General: hint under the description field saying the text is shown in the dashboard server list" })}>
        <TextArea
          value={description}
          onChange={(e) => setAnnotation(DESCRIPTION_ANNOTATION, e.target.value)}
          maxLength={DESCRIPTION_MAX}
          rows={3}
          placeholder={intl.formatMessage({ id: "web.routes.tabs.settings.general.long_standing_survival_realm_invite_only", defaultMessage: "Long-standing survival realm. Invite-only.", description: "General: example placeholder in the description box before typing; an example text, not a default" })}
          className="w-full resize-y"
        />
        <div className="pt-1.5 text-right text-xs tabular-nums text-muted">
          {intl.formatMessage({ id: "web.routes.tabs.settings.general.description_length", defaultMessage: "{length}/{max}", description: "General: character counter under the description box; {length} is the typed length and {max} the maximum allowed" }, { length: String(description.length), max: String(DESCRIPTION_MAX) })}
        </div>
      </Field>

      <Field label={intl.formatMessage({ id: "web.routes.tabs.settings.general.image_override", defaultMessage: "Image override", description: "General: field label for an optional container image that replaces the template's image" })} hint={intl.formatMessage({ id: "web.routes.tabs.settings.general.pin_a_specific_game_container_image", defaultMessage: "Pin a specific game-container image. Leave blank to use the template default.", description: "General: hint under the image override field; leave it blank to use the template's default image" })}>
        <Input
          value={draft.spec.image ?? ""}
          onChange={(e) =>
            onChange({
              ...draft,
              spec: { ...draft.spec, image: e.target.value || undefined },
            })
          }
          placeholder={template?.spec.image ?? intl.formatMessage({ id: "web.routes.tabs.settings.general.template_image", defaultMessage: "(template image)", description: "General: placeholder of the image override input when the template image is unknown" })}
          spellCheck={false}
          className="w-full font-mono text-[13px]"
        />
      </Field>

      <Field label={intl.formatMessage({ id: "web.routes.tabs.settings.general.labels", defaultMessage: "Labels", description: "General: field label for the list of Kubernetes labels set on the server" })} hint={intl.formatMessage({ id: "web.routes.tabs.settings.general.free_form_kubernetes_labels", defaultMessage: "Free-form Kubernetes labels.", description: "General: hint under the labels field saying labels are free-form Kubernetes labels" })}>
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
                  <span className="text-muted">{intl.formatMessage({ id: "web.routes.tabs.settings.general.key_value_separator", defaultMessage: "=", description: "General: separator shown between a label key and its value" })}</span>
                  <span className="text-fg">{value}</span>
                  {/* The tooltip lives on a wrapping element's title (react-aria's
                      Button strips a bare `title` prop) so the button keeps its
                      aria-label as the accessible name for role queries. */}
                  <span title={intl.formatMessage({ id: "web.routes.tabs.settings.general.remove_label", defaultMessage: "Remove label", description: "General: tooltip and accessible label of the icon button that removes one label row; keep it short" })}>
                    <Button
                      isIconOnly
                      variant="ghost"
                      size="sm"
                      aria-label={intl.formatMessage({ id: "web.routes.tabs.settings.general.remove_label", defaultMessage: "Remove label", description: "General: tooltip and accessible label of the icon button that removes one label row; keep it short" })}
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
              placeholder={intl.formatMessage({ id: "web.routes.tabs.settings.general.key", defaultMessage: "key", description: "General: placeholder in the label key box of the new label row, shown before typing" })}
              spellCheck={false}
              className="min-w-0 flex-1 font-mono text-[13px]"
            />
            <Input
              value={labelDraft.value}
              onChange={(e) => setLabelDraft({ ...labelDraft, value: e.target.value })}
              placeholder={intl.formatMessage({ id: "web.routes.tabs.settings.general.value", defaultMessage: "value", description: "General: placeholder in the label value box of the new label row, shown before typing" })}
              spellCheck={false}
              className="min-w-0 flex-1 font-mono text-[13px]"
            />
            <Button variant="outline" onPress={addLabel} isDisabled={!labelDraft.key.trim()}>
              <Plus className="h-4 w-4" />
              {intl.formatMessage({ id: "web.routes.tabs.settings.general.add", defaultMessage: "Add", description: "Button that adds the typed label key and value" })}
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
