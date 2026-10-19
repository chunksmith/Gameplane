import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { cn } from "@/lib/utils";

export function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel, mono = false }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  mono?: boolean;
}) {
  return (
    <ToggleButtonGroup
      aria-label={ariaLabel}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const [key] = keys;
        const option = options.find((candidate) => candidate.value === key);
        if (option) onChange(option.value);
      }}
      className="inline-flex rounded-lg border border-border bg-surface p-0.5"
    >
      {options.map((option) => (
        <ToggleButton
          key={option.value}
          id={option.value}
          className={cn("rounded-md px-2.5 py-1 text-xs text-muted data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent-soft-foreground", mono && "font-mono")}
        >
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
