import { defineMessages } from "react-intl";
import { useFormat, useOptionalIntl } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

const TEXT = defineMessages({
  empty_value: {
    id: "web.common.empty_value",
    defaultMessage: "—",
    description: "Shown in place of a value that is not set",
  },
});

const FILL_CLASS = { cpu: "bg-accent", memory: "bg-chart-stat" };

export function InlineMeter({ pct, tone }: { pct: number | null; tone: "cpu" | "memory" }) {
  const intl = useOptionalIntl();
  const format = useFormat();
  const width = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  const fillClass = pct !== null && pct >= 85 ? "bg-warning" : FILL_CLASS[tone];

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border/40">
        <div className={cn("h-full rounded-full", fillClass)} style={{ width: `${width}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-foreground">
        {pct === null ? intl.formatMessage(TEXT.empty_value) : intl.formatMessage({ id: "web.components.statistics.inline_meter.percent", defaultMessage: "{value}%", description: "Statistics table meter: the share of capacity in use, as a whole-number percentage" }, { value: format.number(Math.round(pct)) })}
      </span>
    </div>
  );
}
