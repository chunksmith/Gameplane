import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery } from "@/test/render";
import { UsersPage } from "./Users";

const list = vi.fn();
const create = vi.fn();
vi.mock("@/lib/endpoints", () => ({
  Users: {
    list: () => list(),
    create: (body: unknown) => create(body),
    update: vi.fn(),
    remove: vi.fn(),
    resetPassword: vi.fn(),
  },
}));
// Spread the real module so can() stays available — UsersPage now calls it
// at the top level (audit quick-link gate); only useMe is stubbed.
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  useMe: () => ({
    data: { id: 1, username: "root", displayName: "Root", email: "r@x", role: "admin" },
    error: null,
    isLoading: false,
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode } & Record<string, unknown>) => (
    <a {...rest}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}));

function renderPage() {
  return renderWithQuery(<UsersPage />);
}

beforeEach(() => {
  list.mockResolvedValue([]);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("UsersPage Invite dialog", () => {
  it("opens on Invite click and disables Create until username set", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /Invite user/i }));
    expect(await screen.findByRole("heading", { name: /Invite user/i })).toBeInTheDocument();
    // The dialog's own submit button is also labelled "Invite user"
    // (matching the page's trigger button, which stays in the DOM behind
    // the overlay) — scope to the dialog to disambiguate.
    const dialog = screen.getByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Create user" });
    expect(submit).toBeDisabled();
  });

  it("validates password length", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /Invite user/i }));
    const dialog = await screen.findByRole("dialog");
    const usernameInput = within(dialog).getByPlaceholderText("alice") as HTMLInputElement;
    await userEvent.type(usernameInput, "newuser");
    const pwInput = within(dialog).getByPlaceholderText(/At least 12 characters/);
    await userEvent.type(pwInput, "short");
    // The dialog preemptively disables the submit button rather than
    // showing an inline message before the user attempts to submit.
    expect(within(dialog).getByRole("button", { name: "Create user" })).toBeDisabled();
    expect(within(dialog).getByText(/At least 12 characters\./)).toBeInTheDocument();
  });

  it("submits a create with the form values", async () => {
    create.mockResolvedValue({ id: 99 });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /Invite user/i }));
    const dialog = await screen.findByRole("dialog");
    const usernameInput = within(dialog).getByPlaceholderText("alice") as HTMLInputElement;
    await userEvent.type(usernameInput, "newuser");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create user" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const args = create.mock.calls[0][0];
    expect(args.username).toBe("newuser");
  });

  it("Cancel closes the dialog", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /Invite user/i }));
    await screen.findByRole("heading", { name: /Invite user/i });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: /Invite user/i })).not.toBeInTheDocument(),
    );
  });
});
