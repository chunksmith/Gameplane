import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActiveBackups, BackupProgressBar, isActiveBackup } from "@/components/backups/ActiveBackups";
import { SCHEDULE_LABEL, formatDuration } from "@/lib/backupGroups";
import { located, type FleetTarget } from "@/lib/fleet";
import { formatBytes } from "@/lib/utils";
import { makeBackup } from "@/test/factories";
import type { Backup } from "@/types";

const target = (name: string): FleetTarget => ({ cluster: "local", namespace: "gameplane-games", name, uid: `${name}-uid` });

const fleetBackup = (name: string, over: Partial<Backup> = {}) => {
  const base = makeBackup();
  return located({
    target: target(name),
    resource: makeBackup({ spec: { ...base.spec, serverRef: { ...base.spec.serverRef, name } }, ...over }),
    permissions: ["*"],
  });
};

describe("isActiveBackup", () => {
  it.each(["Queued", "Pending", "Running"] as const)("treats a %s backup as active", (phase) => {
    expect(isActiveBackup(makeBackup({ status: { phase } }))).toBe(true);
  });

  it("treats a backup without status as active", () => {
    expect(isActiveBackup(makeBackup({ status: undefined }))).toBe(true);
  });

  it("treats a succeeded backup as inactive", () => {
    expect(isActiveBackup(makeBackup({ status: { phase: "Succeeded" } }))).toBe(false);
  });
});

describe("BackupProgressBar", () => {
  it("shows the queue message with an indeterminate bar", () => {
    const { container } = render(
      <BackupProgressBar backup={makeBackup({ status: { phase: "Queued", message: "Waiting behind 2 backups" } })} />,
    );
    expect(screen.getByText("Waiting behind 2 backups")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("falls back to the default queue message", () => {
    render(<BackupProgressBar backup={makeBackup({ status: { phase: "Queued" } })} />);
    expect(screen.getByText("Waiting for a free slot")).toBeInTheDocument();
  });

  it("shows preparing text for a pending backup even when progress exists", () => {
    const { container } = render(
      <BackupProgressBar backup={makeBackup({ status: { phase: "Pending", progress: { percentDone: 30 } } })} />,
    );
    expect(screen.getByText("Preparing…")).toBeInTheDocument();
    expect(screen.queryByText("30%")).not.toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("shows preparing text when the backup has no status", () => {
    render(<BackupProgressBar backup={makeBackup({ status: undefined })} />);
    expect(screen.getByText("Preparing…")).toBeInTheDocument();
  });

  it("shows scanning text for a running backup without progress", () => {
    const { container } = render(<BackupProgressBar backup={makeBackup({ status: { phase: "Running" } })} />);
    expect(screen.getByText("Scanning files…")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("shows zero percent and minimum bar width when running without details", () => {
    const { container } = render(
      <BackupProgressBar backup={makeBackup({ status: { phase: "Running", progress: { percentDone: 0 } } })} />,
    );
    expect(screen.getByText("Scanning files…")).toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(container.querySelector(".bg-accent")).toHaveStyle({ width: "2%" });
  });

  it("shows bytes, files, time and percent for a running backup", () => {
    const { container } = render(
      <BackupProgressBar
        backup={makeBackup({
          status: {
            phase: "Running",
            progress: { percentDone: 50, bytesDone: 512, totalBytes: 1024, filesDone: 12, totalFiles: 40, secondsRemaining: 300 },
          },
        })}
      />,
    );
    expect(
      screen.getByText(`${formatBytes(512)} of ${formatBytes(1024)} · 12 / 40 files · ~${formatDuration(300)} left`),
    ).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(container.querySelector(".bg-accent")).toHaveStyle({ width: "50%" });
  });

  it("hides file counts in compact mode", () => {
    render(
      <BackupProgressBar
        backup={makeBackup({
          status: { phase: "Running", progress: { percentDone: 50, bytesDone: 512, totalBytes: 1024, filesDone: 12, totalFiles: 40 } },
        })}
        compact
      />,
    );
    expect(screen.getByText(`${formatBytes(512)} of ${formatBytes(1024)}`)).toBeInTheDocument();
    expect(screen.queryByText(/files/)).not.toBeInTheDocument();
  });

  it("defaults missing byte and file values to zero", () => {
    render(
      <BackupProgressBar backup={makeBackup({ status: { phase: "Running", progress: { percentDone: 0, totalBytes: 1024, totalFiles: 40 } } })} />,
    );
    expect(screen.getByText(`${formatBytes(0)} of ${formatBytes(1024)} · 0 / 40 files`)).toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("drops zero totals and time from the details", () => {
    render(
      <BackupProgressBar
        backup={makeBackup({
          status: { phase: "Running", progress: { percentDone: 5, totalBytes: 0, totalFiles: 0, secondsRemaining: 0 } },
        })}
      />,
    );
    expect(screen.getByText("Scanning files…")).toBeInTheDocument();
    expect(screen.getByText("5%")).toBeInTheDocument();
  });
});

describe("ActiveBackups", () => {
  it("renders nothing without backups", () => {
    const { container } = render(<ActiveBackups backups={[]} onSelect={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the in-progress header with the backup count", () => {
    render(
      <ActiveBackups
        backups={[fleetBackup("run-srv", { status: { phase: "Running" } }), fleetBackup("pend-srv", { status: { phase: "Pending" } })]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("In progress").nextElementSibling).toHaveTextContent(/^2$/);
  });

  it("orders running, then pending and unknown phases, then queued", () => {
    render(
      <ActiveBackups
        backups={[
          fleetBackup("queue-srv", { status: { phase: "Queued" } }),
          fleetBackup("run-srv", { status: { phase: "Running" } }),
          fleetBackup("bare-srv", { status: undefined }),
          fleetBackup("pend-srv", { status: { phase: "Pending" } }),
          fleetBackup("done-srv", { status: { phase: "Succeeded" } }),
        ]}
        onSelect={vi.fn()}
      />,
    );
    const names = screen.getAllByRole("listitem").map((item) => within(item).getByText(/-srv$/).textContent);
    expect(names).toEqual(["run-srv", "bare-srv", "pend-srv", "done-srv", "queue-srv"]);
  });

  it("shows the schedule label or manual, the start time and the queued hourglass", () => {
    const startTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    render(
      <ActiveBackups
        backups={[
          fleetBackup("sched-srv", {
            metadata: { ...makeBackup().metadata, labels: { [SCHEDULE_LABEL]: "nightly" } },
            status: { phase: "Running", startTime },
          }),
          fleetBackup("manual-srv", { status: { phase: "Queued" } }),
        ]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/nightly/)).toBeInTheDocument();
    expect(screen.getByText(/started .*ago/)).toBeInTheDocument();
    expect(screen.getByText("manual")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /manual-srv/ }).querySelector(".text-muted > svg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sched-srv/ }).querySelector(".text-muted > svg")).not.toBeInTheDocument();
  });

  it("selects the clicked backup", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const running = fleetBackup("run-srv", { status: { phase: "Running" } });
    const queued = fleetBackup("queue-srv", { status: { phase: "Queued" } });
    render(<ActiveBackups backups={[running, queued]} onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: /queue-srv/ }));
    await user.click(screen.getByRole("button", { name: /run-srv/ }));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenNthCalledWith(1, queued);
    expect(onSelect).toHaveBeenNthCalledWith(2, running);
  });
});
