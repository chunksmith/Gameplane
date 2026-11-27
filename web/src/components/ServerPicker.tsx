import { useState, type ReactNode } from "react";
import { Input } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { Check, Plus, X } from "lucide-react";
import { targetKey, type FleetItem } from "@/lib/fleet";
import { useOptionalIntl } from "@/lib/i18n/format";
import type { GameServer } from "@/types";

const MESSAGES: Record<string, MessageDescriptor> = defineMessages({
  search: { id: "web.components.server_picker.search", defaultMessage: "Search servers…", description: "Server picker: accessible name and placeholder of the search field" },
  remove_selected: { id: "web.components.server_picker.remove_selected", defaultMessage: "Remove {name} from selection", description: "Server picker: accessible name of the chip that removes a server from the selection; {name} is the server name" },
});

export interface ServerPickerProps {
  items: FleetItem<GameServer>[];
  selected: FleetItem<GameServer>[];
  onToggle: (item: FleetItem<GameServer>) => void;
  filter?: (item: FleetItem<GameServer>) => boolean;
  rowText?: (item: FleetItem<GameServer>) => ReactNode;
}

export function ServerPicker({ items, selected, onToggle, filter, rowText }: ServerPickerProps) {
  const intl = useOptionalIntl();
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const candidates = items.filter((item) => (!filter || filter(item)) && item.target.name.toLowerCase().includes(needle));
  const isSelected = (item: FleetItem<GameServer>) => selected.some((candidate) => targetKey(candidate.target) === targetKey(item.target));

  return (
    <>
      <Input
        aria-label={intl.formatMessage(MESSAGES.search)}
        placeholder={intl.formatMessage(MESSAGES.search)}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((item) => (
            <button
              key={targetKey(item.target)}
              type="button"
              onClick={() => onToggle(item)}
              aria-label={intl.formatMessage(MESSAGES.remove_selected, { name: item.target.name })}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-accent/10 px-2.5 font-mono text-xs text-accent"
            >
              {item.target.name}
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
        {candidates.map((item) => (
          <li key={targetKey(item.target)}>
            <button type="button" aria-pressed={isSelected(item)} onClick={() => onToggle(item)} className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-default/40">
              <span className="truncate font-mono text-xs">{item.target.name}</span>
              <span className="flex items-center gap-2 text-xs text-muted">
                {rowText?.(item)}
                {isSelected(item) ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
