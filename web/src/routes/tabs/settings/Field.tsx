import type { ReactNode } from "react";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="settings-field grid grid-cols-1 items-start gap-2 sm:grid-cols-[220px_minmax(0,1fr)] sm:gap-8">
      <div className="sm:pt-2">
        <div className="text-sm font-medium text-fg">{label}</div>
        {hint && <div className="pt-1 text-xs leading-relaxed text-muted">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
