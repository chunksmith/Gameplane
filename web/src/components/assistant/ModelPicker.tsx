import { ListBox, ListBoxItem, Select } from "@heroui/react";
import { Sparkles } from "lucide-react";
import { ASSISTANT_PICKS, modelLabel, type AssistantPick } from "@/lib/assistant";
import { useOptionalIntl } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

interface ModelPickerProps {
  value: AssistantPick;
  onChange: (pick: AssistantPick) => void;
  isDisabled?: boolean;
  className?: string;
}

export function ModelPicker({ value, onChange, isDisabled, className }: ModelPickerProps) {
  const intl = useOptionalIntl();
  const label = intl.formatMessage({ id: "web.components.assistant.model_picker.label", defaultMessage: "Model", description: "Assistant model picker: accessible name of the dropdown above the message box that picks the Claude model; keep it short" });
  const current = ASSISTANT_PICKS.find((pick) => pick.model === value.model);
  const select = (key: unknown) => {
    const pick = ASSISTANT_PICKS.find((option) => option.model === key);
    if (pick) onChange({ model: pick.model, effort: pick.effort });
  };
  return (
    <Select aria-label={label} selectedKey={current?.model ?? null} isDisabled={isDisabled} onSelectionChange={select}>
      <Select.Trigger data-chip className={cn(className, "bg-accent-soft text-accent-soft-foreground hover:bg-accent-soft/80")}>
        <Sparkles className="h-3 w-3" />
        <span>
          {intl.formatMessage(
            { id: "web.components.assistant.model_picker.value", defaultMessage: "{model} · {effort}", description: "Assistant model picker: text of the dropdown button; {model} is the model name and {effort} its fixed effort level such as medium or high" },
            { model: current?.label ?? modelLabel(value.model), effort: value.effort },
          )}
        </span>
        <Select.Indicator className="h-3 w-3" />
      </Select.Trigger>
      <Select.Popover className="rounded border border-border">
        <ListBox aria-label={label}>
          {ASSISTANT_PICKS.map((pick) => (
            <ListBoxItem key={pick.model} id={pick.model} textValue={pick.label}>
              <span className="flex flex-col">
                <span className="text-sm font-medium">{pick.label}</span>
                <span className="text-xs text-muted">{intl.formatMessage(pick.hint, { effort: pick.effort })}</span>
              </span>
            </ListBoxItem>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
