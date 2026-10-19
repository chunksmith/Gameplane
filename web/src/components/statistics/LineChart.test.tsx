import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { StatisticsPoint } from "@/types";
import { ChartLegend, LineChart } from "./LineChart";

const points: StatisticsPoint[] = [
  [1_700_000_000, 10],
  [1_700_000_030, 20],
  [1_700_000_060, 30],
];
const formatValue = (value: number) => `${value} u`;
const inbound = { key: "in", label: "Inbound", color: "var(--chart-inbound)", points };

afterEach(() => {
  vi.useRealTimers();
});

describe("LineChart", () => {
  it("labels the chart and scales the y axis from zero to a nice maximum", () => {
    render(<LineChart series={[inbound]} range="15m" formatValue={formatValue} ariaLabel="Network throughput" />);
    expect(screen.getByRole("img", { name: "Network throughput" })).toBeInTheDocument();
    expect(screen.getByText("0 u")).toBeInTheDocument();
    expect(screen.getByText("30 u")).toBeInTheDocument();
  });

  it("shows the empty state when no series has samples", () => {
    render(<LineChart series={[{ ...inbound, points: [] }]} range="15m" formatValue={formatValue} ariaLabel="Network throughput" />);
    expect(screen.getByText("No data for this range")).toBeInTheDocument();
  });

  it("draws a dashed threshold line when asked", () => {
    const { container } = render(
      <LineChart
        series={[inbound]}
        thresholds={[{ key: "requested", label: "Requested", value: 20, color: "var(--muted)", dashed: true }]}
        range="15m"
        formatValue={formatValue}
        ariaLabel="CPU usage"
      />,
    );
    expect(container.querySelectorAll("line[stroke-dasharray]")).toHaveLength(1);
  });

  it("shows the nearest sample on hover and clears it on pointer leave", () => {
    const { container } = render(<LineChart series={[inbound]} range="15m" formatValue={formatValue} ariaLabel="Network throughput" />);
    const plot = container.querySelector("svg")?.parentElement as HTMLElement;
    fireEvent.pointerMove(plot, { clientX: 0 });
    expect(screen.getByText("Inbound")).toBeInTheDocument();
    expect(screen.getByText("10 u")).toBeInTheDocument();
    fireEvent.pointerLeave(plot);
    expect(screen.queryByText("Inbound")).not.toBeInTheDocument();
  });

  it("labels the last tick now when the data is current", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(points[2][0] * 1000));
    render(<LineChart series={[inbound]} range="15m" formatValue={formatValue} ariaLabel="Network throughput" />);
    expect(screen.getByText("now")).toBeInTheDocument();
  });

  it("rounds the y axis to nice ticks in the given display unit", () => {
    const mib = 1024 * 1024;
    const formatMib = (value: number) => `${value / mib} MB/s`;
    render(
      <LineChart
        series={[{ ...inbound, points: [[1_700_000_000, 70 * mib], [1_700_000_030, 10 * mib]] }]}
        range="15m"
        formatValue={formatMib}
        unitBase={mib}
        ariaLabel="Network throughput"
      />,
    );
    expect(screen.getByText(formatMib(80 * mib))).toBeInTheDocument();
    expect(screen.getByText(formatMib(0))).toBeInTheDocument();
  });
});

describe("ChartLegend", () => {
  it("renders one entry per item", () => {
    const { container } = render(
      <ChartLegend
        items={[
          { label: "Inbound", color: "var(--chart-inbound)" },
          { label: "Outbound", color: "var(--chart-outbound)" },
          { label: "Requested", color: "var(--muted)", dashed: true },
        ]}
      />,
    );
    expect(screen.getByText("Inbound")).toBeInTheDocument();
    expect(screen.getByText("Outbound")).toBeInTheDocument();
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });
});
