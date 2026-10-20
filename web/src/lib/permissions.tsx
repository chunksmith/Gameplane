import { Check, Plus } from "lucide-react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { useOptionalIntl } from "@/lib/i18n/format";

const SERVER_PERMISSION_MESSAGES = defineMessages({
  view: { id: "web.lib.permissions.view", defaultMessage: "View", description: "Permission chips: name of the view permission, which every grant includes and cannot be removed; keep it short" },
  console: { id: "web.lib.permissions.console", defaultMessage: "Console", description: "Permission chips: name of the console permission, which lets a member use the server console; keep it short" },
  manage: { id: "web.lib.permissions.manage", defaultMessage: "Manage", description: "Permission chips: name of the permission that lets a member start, stop, change files, mods and players of a server; keep it short" },
});

export const SERVER_PERMISSIONS: { key: string; label: MessageDescriptor }[] = [
  { key: "servers:console", label: SERVER_PERMISSION_MESSAGES.console },
  { key: "servers:write", label: SERVER_PERMISSION_MESSAGES.manage },
];

export function PermissionChips({
  value,
  onChange,
  isDisabled,
  label,
}: {
  value: string[];
  onChange?: (next: string[]) => void;
  isDisabled?: boolean;
  label: string;
}) {
  const intl = useOptionalIntl();
  const isInteractive = !isDisabled && !!onChange;
  const chipClass = "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <button type="button" aria-pressed="true" disabled className={`${chipClass} bg-accent/10 text-accent`}>
        <Check className="h-3 w-3" aria-hidden="true" />
        {intl.formatMessage(SERVER_PERMISSION_MESSAGES.view)}
      </button>
      {SERVER_PERMISSIONS.map((permission) => {
        const selected = value.includes(permission.key);
        return (
          <button
            key={permission.key}
            type="button"
            aria-pressed={selected}
            disabled={!isInteractive}
            onClick={() => onChange?.(selected ? value.filter((key) => key !== permission.key) : [...value, permission.key])}
            className={`${chipClass} ${selected ? "bg-accent/10 text-accent" : "border border-border text-muted hover:text-foreground"}`}
          >
            {selected ? <Check className="h-3 w-3" aria-hidden="true" /> : <Plus className="h-3 w-3" aria-hidden="true" />}
            {intl.formatMessage(permission.label)}
          </button>
        );
      })}
    </div>
  );
}
