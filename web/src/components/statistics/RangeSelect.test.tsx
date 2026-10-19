import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RangeSelect } from "./RangeSelect";

describe("RangeSelect", () => {
  it("marks the active range and reports the chosen one", async () => {
    const onChange = vi.fn();
    render(<RangeSelect value="24h" onChange={onChange} />);
    expect(screen.getByRole("radiogroup", { name: "Time range" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "24h" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "1h" }));
    expect(onChange).toHaveBeenCalledWith("1h");
  });
});
