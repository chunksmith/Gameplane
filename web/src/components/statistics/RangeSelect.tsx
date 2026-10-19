import { defineMessages, type MessageDescriptor } from "react-intl";
import { useOptionalIntl } from "@/lib/i18n/format";
import { STATISTICS_RANGES } from "@/lib/statistics";
import type { StatisticsRange } from "@/types";
import { SegmentedControl } from "./SegmentedControl";

const TEXT = defineMessages({
  aria_label: {
    id: "web.components.statistics.range_select.aria_label",
    defaultMessage: "Time range",
    description: "Statistics range switch: accessible name of the group of time range buttons; not shown as text",
  },
  range_15m: {
    id: "web.components.statistics.range_select.range_15m",
    defaultMessage: "15m",
    description: "Statistics range switch: button for the last 15 minutes; keep the short form",
  },
  range_1h: {
    id: "web.components.statistics.range_select.range_1h",
    defaultMessage: "1h",
    description: "Statistics range switch: button for the last hour; keep the short form",
  },
  range_6h: {
    id: "web.components.statistics.range_select.range_6h",
    defaultMessage: "6h",
    description: "Statistics range switch: button for the last 6 hours; keep the short form",
  },
  range_24h: {
    id: "web.components.statistics.range_select.range_24h",
    defaultMessage: "24h",
    description: "Statistics range switch: button for the last 24 hours; keep the short form",
  },
  range_7d: {
    id: "web.components.statistics.range_select.range_7d",
    defaultMessage: "7d",
    description: "Statistics range switch: button for the last 7 days; keep the short form",
  },
  range_30d: {
    id: "web.components.statistics.range_select.range_30d",
    defaultMessage: "30d",
    description: "Statistics range switch: button for the last 30 days; keep the short form",
  },
});

const RANGE_LABELS: Record<StatisticsRange, MessageDescriptor> = {
  "15m": TEXT.range_15m,
  "1h": TEXT.range_1h,
  "6h": TEXT.range_6h,
  "24h": TEXT.range_24h,
  "7d": TEXT.range_7d,
  "30d": TEXT.range_30d,
};

export function RangeSelect({ value, onChange }: { value: StatisticsRange; onChange: (range: StatisticsRange) => void }) {
  const intl = useOptionalIntl();
  return (
    <SegmentedControl
      options={STATISTICS_RANGES.map((range) => ({ value: range, label: intl.formatMessage(RANGE_LABELS[range]) }))}
      value={value}
      onChange={onChange}
      ariaLabel={intl.formatMessage(TEXT.aria_label)}
      mono
    />
  );
}
