import { useState } from "react";
import { Button, Checkbox, Input } from "@heroui/react";
import { Plus } from "lucide-react";
import { GROUP_NAME } from "@/lib/backupGroups";
import { useOptionalIntl } from "@/lib/i18n/format";

export function GroupPicker({ known, value, onChange }: { known: string[]; value: string[]; onChange: (groups: string[]) => void }) {
  const intl = useOptionalIntl();
  const [draft, setDraft] = useState("");
  const options = [...new Set([...known, ...value])].sort();
  const valid = GROUP_NAME.test(draft);
  const toggle = (group: string) => onChange(value.includes(group) ? value.filter((g) => g !== group) : [...value, group].sort());
  const add = () => {
    if (!valid) return;
    if (!value.includes(draft)) onChange([...value, draft].sort());
    setDraft("");
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {options.map((group) => (
          <Checkbox
            key={group}
            isSelected={value.includes(group)}
            onChange={() => toggle(group)}
            className="flex-row items-center gap-2 rounded-full border border-border px-3 py-1.5 data-[selected=true]:border-accent data-[selected=true]:bg-accent/10"
          >
            <Checkbox.Control className="size-4">
              <Checkbox.Indicator />
            </Checkbox.Control>
            <Checkbox.Content>
              <span className="font-mono text-xs">{group}</span>
            </Checkbox.Content>
          </Checkbox>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          aria-label={intl.formatMessage({ id: "web.components.backups.group_picker.new_group", defaultMessage: "New group", description: "Group picker: accessible name of the input where a new backup group name is typed" })}
          placeholder={intl.formatMessage({ id: "web.components.backups.group_picker.new_group_2", defaultMessage: "new-group", description: "Group picker: example group name shown as the placeholder of the new group input; keep it as a lowercase slug" })}
          value={draft}
          onChange={(e) => setDraft(e.target.value.toLowerCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          className="h-9 flex-1 font-mono"
        />
        <Button size="sm" variant="outline" isDisabled={!valid} onPress={add}>
          <Plus className="h-4 w-4" /> {intl.formatMessage({ id: "web.components.backups.group_picker.add", defaultMessage: "Add", description: "Group picker: button that adds the typed group name to the selected groups; keep it short" })}
        </Button>
      </div>
    </div>
  );
}
