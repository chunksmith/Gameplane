import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelPicker } from "./ModelPicker";

describe("ModelPicker", () => {
  it("shows the current model with its effort", () => {
    render(<ModelPicker value={{ model: "claude-sonnet-5-5", effort: "high" }} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Model/ })).toHaveTextContent("Sonnet 5.5 · high");
  });

  it("falls back to the model label for a model outside the picker", () => {
    render(<ModelPicker value={{ model: "claude-fable-5-1", effort: "high" }} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Model/ })).toHaveTextContent("Claude Fable 5.1 · high");
  });

  it("picks a model with its fixed recommended effort", async () => {
    const onChange = vi.fn();
    render(<ModelPicker value={{ model: "claude-sonnet-5-5", effort: "high" }} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /Model/ }));
    expect(screen.getByText("Most capable · medium effort")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: /Haiku 5.5/ }));
    expect(onChange).toHaveBeenCalledWith({ model: "claude-haiku-5-5", effort: "medium" });
  });
});
