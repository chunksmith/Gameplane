import { Chip as HeroChip } from "@heroui/react";
import type { ReactNode } from "react";

// PhaseChip renders a phase/state badge using HeroUI Chip.
// Maps GameServer, Backup, and Restore phases to HeroUI semantic colors.
// Asleep is a derived display state overlaid on Suspended.

type PhaseColor = "default" | "success" | "warning" | "danger";

// Phase → HeroUI Chip color mapping
// Covers GameServer phases (Pending/Starting/Running/Stopping/Stopped/Suspended/Failed)
// and Backup/Restore phases (Pending/Running/Succeeded/Failed/Suspending/Resuming)
const phaseColorMap: Record<string, PhaseColor> = {
  // Running states
  Running: "success",
  Succeeded: "success",
  // In-transition states
  Starting: "warning",
  Stopping: "warning",
  Suspending: "warning",
  Resuming: "warning",
  // Stopped/idle states
  Pending: "default",
  Queued: "warning",
  Stopped: "default",
  Suspended: "default",
  // Error state
  Failed: "danger",
};

// Generic Chip wrapper for badge use cases
export function Chip({ color = "default", size = "sm", children, className }: {
  color?: PhaseColor;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
  className?: string;
}) {
  return (
    <HeroChip
      color={color}
      size={size}
      data-color={color}
      data-size={size}
      className={className}
    >
      {children}
    </HeroChip>
  );
}

// PhaseChip renders a server/backup/restore phase badge.
export function PhaseChip({ phase, asleep, size = "sm", className }: {
  phase?: string;
  asleep?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const p = phase ?? "Pending";
  const label = asleep ? "Asleep" : p;
  const color = phaseColorMap[p] ?? "default";

  return (
    <HeroChip
      color={color}
      variant="soft"
      size={size}
      data-phase={p}
      data-color={color}
      data-asleep={asleep}
      data-size={size}
      className={className}
    >
      {label}
    </HeroChip>
  );
}
