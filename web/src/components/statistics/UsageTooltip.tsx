import type { ReactNode } from "react";
import { Tooltip } from "@heroui/react";

export function UsageTooltip({ detail, className, children }: { detail: string | undefined; className?: string; children: ReactNode }) {
  if (!detail) return children;
  return (
    <Tooltip delay={150} closeDelay={0}>
      <Tooltip.Trigger className={className}>{children}</Tooltip.Trigger>
      <Tooltip.Content>
        <span className="font-mono text-xs">{detail}</span>
      </Tooltip.Content>
    </Tooltip>
  );
}
