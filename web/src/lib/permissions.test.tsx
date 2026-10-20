import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PermissionChips, SERVER_PERMISSIONS } from "./permissions";

describe("PermissionChips", () => {
  it("always shows View as a locked, selected chip", () => {
    render(<PermissionChips label="Permissions" value={[]} onChange={vi.fn()} />);
    const view = within(screen.getByRole("group", { name: "Permissions" })).getByRole("button", { name: "View" });
    expect(view).toHaveAttribute("aria-pressed", "true");
    expect(view).toBeDisabled();
  });

  it("marks the chips present in value as pressed", () => {
    render(<PermissionChips label="Permissions" value={["servers:write"]} onChange={vi.fn()} />);
    const group = screen.getByRole("group", { name: "Permissions" });
    expect(within(group).getByRole("button", { name: "Console" })).toHaveAttribute("aria-pressed", "false");
    expect(within(group).getByRole("button", { name: "Manage" })).toHaveAttribute("aria-pressed", "true");
  });

  it("adds a permission when an unselected chip is pressed", async () => {
    const onChange = vi.fn();
    render(<PermissionChips label="Permissions" value={["servers:console"]} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(onChange).toHaveBeenCalledWith(["servers:console", "servers:write"]);
  });

  it("removes a permission when a selected chip is pressed", async () => {
    const onChange = vi.fn();
    render(<PermissionChips label="Permissions" value={["servers:console", "servers:write"]} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Console" }));
    expect(onChange).toHaveBeenCalledWith(["servers:write"]);
  });

  it("does not change anything when disabled or without onChange", async () => {
    const onChange = vi.fn();
    const { unmount } = render(<PermissionChips label="Permissions" value={[]} onChange={onChange} isDisabled />);
    expect(screen.getByRole("button", { name: "Console" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Console" }));
    expect(onChange).not.toHaveBeenCalled();
    unmount();

    render(<PermissionChips label="Permissions" value={[]} />);
    expect(screen.getByRole("button", { name: "Manage" })).toBeDisabled();
  });

  it("exposes the console and manage server permissions in order", () => {
    expect(SERVER_PERMISSIONS.map((permission) => permission.key)).toEqual(["servers:console", "servers:write"]);
  });
});
