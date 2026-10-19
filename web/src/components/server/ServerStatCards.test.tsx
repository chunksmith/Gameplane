import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ServerStatCards } from "./ServerStatCards";
import type { GameServer } from "@/types";

function gs(overrides: Partial<GameServer["status"]> = {}): GameServer {
  return {
    metadata: { name: "s1" },
    spec: { templateRef: { name: "minecraft-java" } },
    status: { phase: "Running", ...overrides },
  };
}

describe("ServerStatCards", () => {
  it("renders real CPU, memory, disk, network and uptime from the heartbeat", () => {
    render(<ServerStatCards gs={gs({
      startedAt: new Date(Date.now() - (2 * 3600 + 5 * 60) * 1000).toISOString(),
      agent: {
        lastHeartbeat: "now",
        cpuMillicores: 500, cpuLimitMillicores: 2000,
        memoryBytes: 536870912, memoryLimitBytes: 1073741824,
        diskUsedBytes: 2147483648, diskTotalBytes: 10737418240,
        networkRxBytes: 1073741824, networkTxBytes: 2147483648,
        networkRxBytesPerSec: 1024, networkTxBytesPerSec: 2048,
      },
    })} />);
    expect(screen.getByText("Disk")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText("50% / 200%")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("512 MB / 1.0 GB")).toBeInTheDocument();
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(screen.getByText("2.0 GB / 10 GB")).toBeInTheDocument();
    expect(screen.getByText("Network")).toBeInTheDocument();
    expect(screen.getByText("3.0 KB/s")).toBeInTheDocument();
    expect(screen.getByText("In 1.0 KB/s · Out 2.0 KB/s")).toBeInTheDocument();
    expect(screen.getByText("Since pod start: 1.0 GB in · 2.0 GB out")).toBeInTheDocument();
    expect(screen.getByText("Uptime")).toBeInTheDocument();
    expect(screen.getByText("2h 5m")).toBeInTheDocument();
  });

  it("renders '—' for usage when the agent heartbeat is stale/absent", () => {
    render(<ServerStatCards gs={gs({ agent: { lastHeartbeat: "old", stale: true } })} />);
    expect(screen.getByText("Disk")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("shows cores/bytes and '—' limits when usage is known but limits are absent", () => {
    render(<ServerStatCards gs={gs({
      phase: "Starting",
      agent: {
        lastHeartbeat: "now",
        cpuMillicores: 1500,
        memoryBytes: 536870912,
        diskUsedBytes: 1073741824, diskTotalBytes: 0,
      },
    })} />);
    expect(screen.getByText("150%")).toBeInTheDocument();
    expect(screen.getByText("512 MB")).toBeInTheDocument();
    expect(screen.getByText("512 MB / —")).toBeInTheDocument();
    expect(screen.getByText("1.0 GB")).toBeInTheDocument();
    expect(screen.getByText("1.0 GB / —")).toBeInTheDocument();
  });
});
