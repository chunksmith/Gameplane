import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SplitBars } from "./SplitBars";

const rows = [
  { key: "node-a", label: "node-a", rx: 2e6, tx: 6e6 },
  { key: "node-b", label: "node-b", rx: 1e6, tx: 1e6 },
];

describe("SplitBars", () => {
  it("shows each node's rates in MB/s and labels the chart", () => {
    render(<SplitBars rows={rows} ariaLabel="Bandwidth by node" />);
    expect(screen.getByRole("img", { name: "Bandwidth by node" })).toBeInTheDocument();
    expect(screen.getByText("2.0 / 6.0")).toBeInTheDocument();
    expect(screen.getByText("1.0 / 1.0")).toBeInTheDocument();
  });

  it("sizes each segment against the largest node total", () => {
    const { container } = render(<SplitBars rows={rows} ariaLabel="Bandwidth by node" />);
    const segments = container.querySelectorAll<HTMLElement>("li > div:last-child > span");
    expect(segments[0].style.width).toBe("25%");
    expect(segments[1].style.width).toBe("75%");
  });
});
