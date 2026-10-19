import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SegmentedControl } from "./SegmentedControl";

const options = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

describe("SegmentedControl", () => {
  it("renders every option and marks the selected one", () => {
    render(<SegmentedControl options={options} value="week" onChange={vi.fn()} ariaLabel="Period" />);
    expect(screen.getByRole("radiogroup", { name: "Period" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Week" })).toHaveAttribute("aria-checked", "true");
  });

  it("reports the value of the option that was clicked", async () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={options} value="week" onChange={onChange} ariaLabel="Period" />);
    await userEvent.click(screen.getByRole("radio", { name: "Month" }));
    expect(onChange).toHaveBeenCalledWith("month");
  });
});
