import type { ReactNode } from "react";

export function EmptyState({ icon, title, hint, action }: { icon: ReactNode; title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-default/60 text-muted [&>svg]:h-5 [&>svg]:w-5">{icon}</span>
      <div className="text-sm font-medium text-foreground">{title}</div>
      {hint && <p className="max-w-sm text-xs text-muted">{hint}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
