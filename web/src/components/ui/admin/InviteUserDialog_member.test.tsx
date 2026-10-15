import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InviteUserDialog } from "./InviteUserDialog";

describe("InviteUserDialog default role", () => {
  it("defaults to member when the role exists", async () => {
    const user = userEvent.setup();
    const onInvite = vi.fn();
    render(
      <InviteUserDialog
        open
        onOpenChange={() => {}}
        onInvite={onInvite}
        roles={["admin", "member", "operator", "viewer"]}
      />,
    );
    const inputs = screen.getAllByDisplayValue("") as HTMLInputElement[];
    await user.type(inputs[0], "alice");
    await user.type(inputs[1], "Alice Operator");
    await user.type(inputs[2], "alice@example.com");
    await user.type(inputs[3], "SecurePass123");
    await user.click(screen.getByRole("button", { name: /Invite user/i }));
    expect(onInvite).toHaveBeenCalledWith("alice", "Alice Operator", "alice@example.com", "SecurePass123", "member");
  });

  it("picks member once roles load after the dialog mounts", async () => {
    const user = userEvent.setup();
    const onInvite = vi.fn();
    const { rerender } = render(<InviteUserDialog open contactFieldsOptional onOpenChange={() => {}} onInvite={onInvite} roles={[]} />);
    rerender(<InviteUserDialog open contactFieldsOptional onOpenChange={() => {}} onInvite={onInvite} roles={["admin", "member", "viewer"]} />);
    const inputs = screen.getAllByDisplayValue("") as HTMLInputElement[];
    await user.type(inputs[0], "bob");
    await user.click(screen.getByRole("button", { name: /Invite user/i }));
    expect(onInvite).toHaveBeenCalledWith("bob", "", "", "", "member");
  });
});
