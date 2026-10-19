import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LiveCard } from "./LiveCard";

describe("LiveCard", () => {
  it("renders the value, unit, delta, peak and sparkline", () => {
    const { container } = render(
      <LiveCard
        label="CPU"
        icon={<span>icon</span>}
        tone="cpu"
        value="9.2"
        unit="%"
        sub="21.4 of 232 cores in use"
        delta={{ text: "0.8 pt", direction: "up" }}
        series={[1, 2, 3, 2]}
        peak="14.1%"
      />,
    );
    expect(screen.getByText("CPU")).toBeInTheDocument();
    expect(screen.getByText("9.2")).toBeInTheDocument();
    expect(screen.getByText("%")).toBeInTheDocument();
    expect(screen.getByText("21.4 of 232 cores in use")).toBeInTheDocument();
    expect(screen.getByText("0.8 pt")).toBeInTheDocument();
    expect(screen.getByText("Peak 14.1% · 15m")).toBeInTheDocument();
    expect(screen.getByText("now")).toBeInTheDocument();
    expect(container.querySelector("polyline")).not.toBeNull();
  });

  it("shows a dash, the placeholder and an empty box when the value is unavailable", () => {
    const { container } = render(
      <LiveCard label="Inbound" icon={<span>icon</span>} tone="inbound" value={null} series={[]} placeholder="Needs Prometheus" />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("Needs Prometheus")).toBeInTheDocument();
    expect(screen.getByText("No bandwidth data")).toBeInTheDocument();
    expect(container.querySelector("polyline")).toBeNull();
  });
});
