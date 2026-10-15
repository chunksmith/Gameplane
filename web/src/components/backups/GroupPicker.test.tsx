import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GroupPicker } from "@/components/backups/GroupPicker";

function renderPicker(known: string[], value: string[]) {
  const onChange = vi.fn();
  render(<GroupPicker known={known} value={value} onChange={onChange} />);
  return { onChange, user: userEvent.setup() };
}

function renderedGroups() {
  return screen.queryAllByRole("checkbox").map((checkbox) => checkbox.closest("label")?.textContent);
}

describe("GroupPicker", () => {
  it("renders known and selected groups as one sorted list", () => {
    renderPicker(["nightly", "default"], ["custom", "default"]);

    expect(renderedGroups()).toEqual(["custom", "default", "nightly"]);
  });

  it("lists a group that is both known and selected once", () => {
    renderPicker(["default"], ["default"]);

    expect(renderedGroups()).toEqual(["default"]);
  });

  it("renders no checkboxes and a disabled Add button without groups", () => {
    renderPicker([], []);

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("checks only the selected groups", () => {
    renderPicker(["default", "nightly"], ["nightly"]);

    expect(screen.getByRole("checkbox", { name: "nightly" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "default" })).not.toBeChecked();
  });

  it("reflects selection passed through value on rerender", () => {
    const onChange = vi.fn();
    const { rerender } = render(<GroupPicker known={["default"]} value={[]} onChange={onChange} />);

    expect(screen.getByRole("checkbox", { name: "default" })).not.toBeChecked();

    rerender(<GroupPicker known={["default"]} value={["default"]} onChange={onChange} />);

    expect(screen.getByRole("checkbox", { name: "default" })).toBeChecked();
  });

  it("selects an unselected group and keeps the list sorted", async () => {
    const { onChange, user } = renderPicker(["alpha", "zeta"], ["zeta"]);

    await user.click(screen.getByRole("checkbox", { name: "alpha" }));

    expect(onChange).toHaveBeenCalledWith(["alpha", "zeta"]);
  });

  it("deselects a selected group", async () => {
    const { onChange, user } = renderPicker(["default", "nightly"], ["default", "nightly"]);

    await user.click(screen.getByRole("checkbox", { name: "default" }));

    expect(onChange).toHaveBeenCalledWith(["nightly"]);
  });

  it("deselects a selected group that is not in the known list", async () => {
    const { onChange, user } = renderPicker([], ["custom"]);

    await user.click(screen.getByRole("checkbox", { name: "custom" }));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("lowercases the typed group name", async () => {
    const { user } = renderPicker([], []);
    const input = screen.getByRole("textbox", { name: "New group" });

    await user.type(input, "OPS-Team");

    expect(input).toHaveValue("ops-team");
  });

  it("keeps Add disabled until the draft is a valid group name", async () => {
    const { user } = renderPicker([], []);
    const input = screen.getByRole("textbox", { name: "New group" });
    const addButton = screen.getByRole("button", { name: "Add" });

    await user.type(input, "bad name!");
    expect(addButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, "ops-team");
    expect(addButton).toBeEnabled();
  });

  it("adds a typed group through the Add button, sorted, and clears the draft", async () => {
    const { onChange, user } = renderPicker(["zeta"], ["zeta"]);
    const input = screen.getByRole("textbox", { name: "New group" });

    await user.type(input, "alpha");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(onChange).toHaveBeenCalledWith(["alpha", "zeta"]);
    expect(input).toHaveValue("");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("adds a typed group on Enter and clears the draft", async () => {
    const { onChange, user } = renderPicker([], []);
    const input = screen.getByRole("textbox", { name: "New group" });

    await user.type(input, "ops-team{Enter}");

    expect(onChange).toHaveBeenCalledWith(["ops-team"]);
    expect(input).toHaveValue("");
  });

  it("ignores Enter when the draft is not a valid group name", async () => {
    const { onChange, user } = renderPicker([], []);
    const input = screen.getByRole("textbox", { name: "New group" });

    await user.type(input, "bad name!{Enter}");

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("bad name!");
  });

  it("clears a duplicate group on Enter without calling onChange", async () => {
    const { onChange, user } = renderPicker(["default"], ["default"]);
    const input = screen.getByRole("textbox", { name: "New group" });

    await user.type(input, "default{Enter}");

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
  });
});
