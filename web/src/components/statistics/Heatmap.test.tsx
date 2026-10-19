import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Heatmap } from "./Heatmap";

const buckets = Array.from({ length: 24 }, (_, index) => 1_700_000_000 + index * 3600);
const rows = [
  { key: "node-a", label: "node-a", values: Array.from({ length: 24 }, (_, index) => (index === 2 ? null : index * 4)) },
  { key: "node-b", label: "node-b", values: Array.from({ length: 24 }, (_, index) => index * 2) },
];

function renderHeatmap() {
  return render(
    <Heatmap
      rows={rows}
      buckets={buckets}
      range="24h"
      max={100}
      color="var(--accent)"
      formatValue={(value) => `${value}%`}
      legendLabel="CPU"
      ariaLabel="Utilization heatmap"
    />,
  );
}

describe("Heatmap", () => {
  it("renders the labelled grid with its scale", () => {
    renderHeatmap();
    expect(screen.getByRole("img", { name: "Utilization heatmap" })).toBeInTheDocument();
    expect(screen.getAllByText("node-a")).toHaveLength(2);
    expect(screen.getByText("100%+ CPU")).toBeInTheDocument();
  });

  it("labels every third bucket", () => {
    renderHeatmap();
    expect(screen.getAllByText(/^\d{2}:\d{2}$/).length).toBeGreaterThanOrEqual(8);
  });

  it("shows the node, time and value of the hovered cell", () => {
    const { container } = renderHeatmap();
    fireEvent.pointerEnter(container.querySelector('[data-row="node-a"][data-column="3"]') as HTMLElement);
    expect(screen.getByText(/^node-a at /)).toHaveTextContent("12%");
  });
});
