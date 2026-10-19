import { useEffect, useState, type ReactNode } from "react";
import { ArrowDownUp, Clock, Cpu, HardDrive, MemoryStick } from "lucide-react";
import { Card } from "@heroui/react";
import type { GameServer } from "@/types";
import { Sparkline } from "@/components/ui/Sparkline";
import { formatBytes, formatCpuPercent, formatUptime } from "@/lib/utils";
import { useOptionalIntl } from "@/lib/i18n/format";
import { defineMessages } from "react-intl";

const TEXT = defineMessages({
  empty_value: { id: "web.common.empty_value", defaultMessage: "—", description: "Shown in place of a value that is not set" },
  cpu: { id: "web.components.server.server_stat_cards.cpu", defaultMessage: "CPU", description: "Server stat cards: label of the CPU usage card; technical term, usually left untranslated" },
  memory: { id: "web.components.server.server_stat_cards.memory", defaultMessage: "Memory", description: "Server stat cards: label of the memory usage card" },
  disk: { id: "web.components.server.server_stat_cards.disk", defaultMessage: "Disk", description: "Server stat cards: label of the disk usage card" },
  network: { id: "web.components.server.server_stat_cards.network", defaultMessage: "Network", description: "Server stat cards: label of the network traffic card, showing the inbound and outbound rate" },
  uptime: { id: "web.components.server.server_stat_cards.uptime", defaultMessage: "Uptime", description: "Server stat cards: label of the card showing how long the server has been running" },
});

export function ServerStatCards({ gs }: { gs?: GameServer }) {
  const intl = useOptionalIntl();
  const empty = intl.formatMessage(TEXT.empty_value);
  const status = gs?.status;
  const agent = status?.agent;
  const cpuKnown = typeof agent?.cpuMillicores === "number";
  const cpuMilli = cpuKnown ? (agent?.cpuMillicores as number) : 0;
  const cpuLimitMilli =
    typeof agent?.cpuLimitMillicores === "number" ? (agent?.cpuLimitMillicores as number) : 0;
  const cpuPct = cpuKnown && cpuLimitMilli ? (cpuMilli / cpuLimitMilli) * 100 : 0;

  const memKnown = typeof agent?.memoryBytes === "number";
  const memUsed = memKnown ? (agent?.memoryBytes as number) : 0;
  const memLimit =
    typeof agent?.memoryLimitBytes === "number" ? (agent?.memoryLimitBytes as number) : 0;
  const memPct = memKnown && memLimit ? (memUsed / memLimit) * 100 : 0;

  const diskKnown =
    typeof agent?.diskUsedBytes === "number" && typeof agent?.diskTotalBytes === "number";
  const diskUsed = diskKnown ? (agent?.diskUsedBytes as number) : 0;
  const diskTotal = diskKnown ? (agent?.diskTotalBytes as number) : 0;
  const diskPct = diskKnown && diskTotal ? (diskUsed / diskTotal) * 100 : 0;

  const netRateKnown =
    typeof agent?.networkRxBytesPerSec === "number" && typeof agent?.networkTxBytesPerSec === "number";
  const netRxRate = netRateKnown ? (agent?.networkRxBytesPerSec as number) : 0;
  const netTxRate = netRateKnown ? (agent?.networkTxBytesPerSec as number) : 0;
  const netTotalKnown =
    typeof agent?.networkRxBytes === "number" && typeof agent?.networkTxBytes === "number";
  const netRxTotal = netTotalKnown ? (agent?.networkRxBytes as number) : 0;
  const netTxTotal = netTotalKnown ? (agent?.networkTxBytes as number) : 0;

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-5">
      <ResourceCard
        label={intl.formatMessage(TEXT.cpu)}
        icon={<Cpu className="h-4 w-4" />}
        value={
          cpuKnown ? (cpuLimitMilli ? `${cpuPct.toFixed(0)}%` : formatCpuPercent(cpuMilli / 1000)) : empty
        }
        sub={
          cpuKnown && cpuLimitMilli
            ? `${formatCpuPercent(cpuMilli / 1000)} / ${formatCpuPercent(cpuLimitMilli / 1000)}`
            : undefined
        }
        progress={cpuKnown && cpuLimitMilli ? cpuPct : undefined}
        trend={cpuKnown ? (cpuLimitMilli ? cpuPct : cpuMilli) : undefined}
        accent="primary"
      />
      <ResourceCard
        label={intl.formatMessage(TEXT.memory)}
        icon={<MemoryStick className="h-4 w-4" />}
        value={memKnown ? (memLimit ? `${memPct.toFixed(0)}%` : formatBytes(memUsed)) : empty}
        sub={
          memKnown ? intl.formatMessage({ id: "web.components.server.server_stat_cards.used_of_total", defaultMessage: "{used} / {total}", description: "Server stat cards: memory or disk usage against its limit; {used} is the amount in use, {total} the limit" }, { used: formatBytes(memUsed), total: memLimit ? formatBytes(memLimit) : empty }) : undefined
        }
        progress={memKnown && memLimit ? memPct : undefined}
        trend={memKnown && memLimit ? memPct : undefined}
        accent="violet"
      />
      <ResourceCard
        label={intl.formatMessage(TEXT.disk)}
        icon={<HardDrive className="h-4 w-4" />}
        value={diskKnown ? (diskTotal ? `${diskPct.toFixed(0)}%` : formatBytes(diskUsed)) : empty}
        sub={
          diskKnown ? intl.formatMessage({ id: "web.components.server.server_stat_cards.used_of_total", defaultMessage: "{used} / {total}", description: "Server stat cards: memory or disk usage against its limit; {used} is the amount in use, {total} the limit" }, { used: formatBytes(diskUsed), total: diskTotal ? formatBytes(diskTotal) : empty }) : undefined
        }
        progress={diskKnown && diskTotal ? diskPct : undefined}
        trend={diskKnown && diskTotal ? diskPct : undefined}
        accent="success"
      />
      <ResourceCard
        label={intl.formatMessage(TEXT.network)}
        icon={<ArrowDownUp className="h-4 w-4" />}
        value={netRateKnown ? `${formatBytes(netRxRate + netTxRate)}/s` : empty}
        sub={
          netRateKnown || netTotalKnown ? (
            <>
              {netRateKnown && <div>{intl.formatMessage({ id: "web.components.server.server_stat_cards.network_rate", defaultMessage: "In {rx}/s · Out {tx}/s", description: "Server stat cards: network card line with the current inbound and outbound rate; {rx} and {tx} are formatted byte amounts per second" }, { rx: formatBytes(netRxRate), tx: formatBytes(netTxRate) })}</div>}
              {netTotalKnown && (
                <div>{intl.formatMessage({ id: "web.components.server.server_stat_cards.network_since_pod_start", defaultMessage: "Since pod start: {rx} in · {tx} out", description: "Server stat cards: network card line with the total bytes received and sent since the pod started; {rx} and {tx} are formatted byte amounts" }, { rx: formatBytes(netRxTotal), tx: formatBytes(netTxTotal) })}</div>
              )}
            </>
          ) : undefined
        }
        trend={netRateKnown ? netRxRate + netTxRate : undefined}
        accent="warning"
      />
      <ResourceCard
        label={intl.formatMessage(TEXT.uptime)}
        icon={<Clock className="h-4 w-4" />}
        value={status?.phase === "Running" ? formatUptime(status.startedAt, intl) : empty}
        accent="success"
      />
    </div>
  );
}

function useMetricHistory(value: number | undefined, max = 32): number[] {
  const [hist, setHist] = useState<number[]>([]);
  useEffect(() => {
    if (value === undefined || Number.isNaN(value)) return;
    const appendSample = () => {
      setHist((h) => {
        const next = h.concat(value);
        return next.length > max ? next.slice(-max) : next;
      });
    };
    appendSample();
  }, [value, max]);
  return hist;
}

function ResourceCard({
  label,
  icon,
  value,
  sub,
  progress,
  trend,
  accent,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  sub?: ReactNode;
  progress?: number;
  trend?: number;
  accent?: "primary" | "success" | "warning" | "violet";
}) {
  const accentClass = {
    primary: "bg-accent",
    success: "bg-success-soft-foreground",
    warning: "bg-warning",
    violet: "bg-violet",
  }[accent ?? "primary"];
  const accentText = {
    primary: "text-accent",
    success: "text-success-soft-foreground",
    warning: "text-warning",
    violet: "text-violet",
  }[accent ?? "primary"];
  const history = useMetricHistory(trend);
  return (
    <Card className="flex flex-col gap-2 border border-border bg-card p-4">
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.5px] text-muted">
        <span>{label}</span>
        <span className="text-muted">{icon}</span>
      </div>
      <div className="font-mono text-2xl font-bold text-foreground">{value}</div>
      <Sparkline data={history} className={accentText} />
      {progress !== undefined && (
        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--default)]">
          <div
            className={`h-full ${accentClass}`}
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>
      )}
      {sub && <div className="space-y-0.5 text-xs text-muted">{sub}</div>}
    </Card>
  );
}
