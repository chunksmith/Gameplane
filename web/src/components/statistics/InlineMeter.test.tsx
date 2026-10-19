import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { InlineMeter } from "./InlineMeter";

describe("InlineMeter", () => {
  it("shows the rounded percentage", () => {
    render(<InlineMeter pct={15.4} tone="cpu" />);
    expect(screen.getByText("15%")).toBeInTheDocument();
  });

  it("switches the fill to warning at 85 percent and above", () => {
    const { container, rerender } = render(<InlineMeter pct={90} tone="memory" />);
    expect(container.querySelector(".bg-warning")).not.toBeNull();
    rerender(<InlineMeter pct={40} tone="memory" />);
    expect(container.querySelector(".bg-warning")).toBeNull();
  });

  it("shows a dash without a value", () => {
    const { container } = render(<InlineMeter pct={null} tone="cpu" />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(container.querySelector(".bg-warning")).toBeNull();
  });
});
