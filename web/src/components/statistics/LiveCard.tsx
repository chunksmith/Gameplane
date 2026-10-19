import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { Card } from "@heroui/react";
import { defineMessages } from "react-intl";
import { Sparkline } from "@/components/ui/Sparkline";
import { useOptionalIntl } from "@/lib/i18n/format";

export type LiveCardTone = "cpu" | "memory" | "inbound" | "outbound";

const TONE_COLOR: Record<LiveCardTone, string> = {
  cpu: "var(--accent)",
  memory: "var(--chart-stat)",
  inbound: "var(--chart-inbound)",
  outbound: "var(--chart-outbound)",
};

const TREND_ICON = { up: ArrowUp, down: ArrowDown, flat: Minus };

const TEXT = defineMessages({
  empty_value: {
    id: "web.common.empty_value",
    defaultMessage: "—",
    description: "Shown in place of a value that is not set",
  },
  no_bandwidth: {
    id: "web.components.statistics.live_card.no_bandwidth",
    defaultMessage: "No bandwidth data",
    description: "Statistics live card: text in the dashed box shown instead of a sparkline when the network rate is unavailable",
  },
  now: {
    id: "web.components.statistics.live_card.now",
    defaultMessage: "now",
    description: "Statistics live card: footer label at the right edge of the sparkline, meaning the current time",
  },
});

export function LiveCard({
  label,
  icon,
  tone,
  value,
  unit,
  sub,
  delta,
  series,
  peak,
  placeholder,
}: {
  label: string;
  icon: ReactNode;
  tone: LiveCardTone;
  value: string | null;
  unit?: string;
  sub?: string;
  delta?: { text: string; direction: "up" | "down" | "flat" };
  series: number[];
  peak?: string;
  placeholder?: string;
}) {
  const intl = useOptionalIntl();
  const color = TONE_COLOR[tone];
  const unavailable = value === null && placeholder !== undefined;
  const subText = unavailable ? placeholder : sub;
  const TrendIcon = delta ? TREND_ICON[delta.direction] : Minus;

  return (
    <Card className="min-w-0 gap-3 border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="grid size-7 shrink-0 place-items-center rounded-md"
            style={{ backgroundColor: `color-mix(in oklch, ${color} 15%, transparent)`, color }}
          >
            {icon}
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</span>
        </div>
        {delta && (
          <span className="hidden shrink-0 items-center gap-1 font-mono text-[11px] text-muted sm:flex">
            <TrendIcon aria-hidden="true" className="size-3" />
            {delta.text}
          </span>
        )}
      </div>
      <div>
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-3xl font-semibold text-foreground">{value ?? intl.formatMessage(TEXT.empty_value)}</span>
          {unit && <span className="font-mono text-sm text-muted">{unit}</span>}
        </div>
        {subText && <p className="mt-1 min-h-8 text-xs text-muted">{subText}</p>}
      </div>
      {unavailable ? (
        <div className="flex h-14 items-center justify-center rounded-md border border-dashed border-border text-xs text-muted">
          {intl.formatMessage(TEXT.no_bandwidth)}
        </div>
      ) : (
        <div className="h-14" style={{ color }}>
          <Sparkline data={series} area fixedMin={0} className="h-full" />
        </div>
      )}
      {peak !== undefined && !unavailable && (
        <div className="hidden items-center justify-between font-mono text-[10px] text-muted sm:flex">
          <span>{intl.formatMessage({ id: "web.components.statistics.live_card.peak", defaultMessage: "Peak {value} · 15m", description: "Statistics live card: footer with the highest value of the last 15 minutes; {value} is the formatted peak" }, { value: peak })}</span>
          <span>{intl.formatMessage(TEXT.now)}</span>
        </div>
      )}
    </Card>
  );
}
