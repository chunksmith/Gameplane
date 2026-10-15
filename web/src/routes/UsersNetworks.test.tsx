import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery } from "@/test/render";
import { NetworksTab } from "./UsersNetworks";

const list = vi.fn();
const create = vi.fn();
const remove = vi.fn();
const addMember = vi.fn();
const removeMember = vi.fn();
const usersList = vi.fn();
vi.mock("@/lib/endpoints", () => ({
  Networks: {
    list: () => list(),
    create: (name: string) => create(name),
    remove: (name: string) => remove(name),
    addMember: (name: string, id: number) => addMember(name, id),
    removeMember: (name: string, id: number) => removeMember(name, id),
  },
  Users: { list: () => usersList() },
}));

const useMeMock = vi.fn();
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  useMe: () => useMeMock(),
}));

const ADMIN = { id: 1, username: "root", permissions: { "*": ["*"] } };

describe("NetworksTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMeMock.mockReturnValue({ data: ADMIN });
    list.mockResolvedValue([
      { name: "skyblock", members: [{ id: 2, username: "ayse" }] },
      { name: "smp", members: [] },
    ]);
    usersList.mockResolvedValue([
      { id: 2, username: "ayse", role: "member" },
      { id: 3, username: "mert", role: "member" },
    ]);
    create.mockResolvedValue({ name: "survival", members: [] });
    remove.mockResolvedValue(undefined);
    addMember.mockResolvedValue(undefined);
    removeMember.mockResolvedValue(undefined);
  });

  it("lists networks with their members", async () => {
    renderWithQuery(<NetworksTab />);
    expect(await screen.findByText("skyblock")).toBeInTheDocument();
    expect(screen.getByText("ayse")).toBeInTheDocument();
    expect(screen.getByText("1 member")).toBeInTheDocument();
    expect(screen.getByText("No members yet")).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    list.mockResolvedValue([]);
    renderWithQuery(<NetworksTab />);
    expect(await screen.findByText("No networks yet.")).toBeInTheDocument();
  });

  it("creates a network", async () => {
    renderWithQuery(<NetworksTab />);
    await userEvent.type(screen.getByLabelText("Network name"), "survival");
    await userEvent.click(screen.getByRole("button", { name: /New network/i }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("survival"));
  });

  it("adds a member by username", async () => {
    renderWithQuery(<NetworksTab />);
    await screen.findByText("smp");
    await waitFor(() => expect(usersList).toHaveBeenCalled());
    await userEvent.type(screen.getByLabelText("Add member to smp"), "mert{Enter}");
    await waitFor(() => expect(addMember).toHaveBeenCalledWith("smp", 3));
  });

  it("reports an unknown username", async () => {
    renderWithQuery(<NetworksTab />);
    await screen.findByText("smp");
    await userEvent.type(screen.getByLabelText("Add member to smp"), "ghost");
    const addButtons = screen.getAllByRole("button", { name: /^Add$/i });
    await userEvent.click(addButtons[addButtons.length - 1]);
    expect(await screen.findByRole("alert")).toHaveTextContent("User ghost not found");
    expect(addMember).not.toHaveBeenCalled();
  });

  it("removes a member", async () => {
    renderWithQuery(<NetworksTab />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove ayse from skyblock" }));
    await waitFor(() => expect(removeMember).toHaveBeenCalledWith("skyblock", 2));
  });

  it("asks for confirmation before deleting a network", async () => {
    renderWithQuery(<NetworksTab />);
    await screen.findByText("smp");
    const deleteButtons = screen.getAllByRole("button", { name: /^Delete$/i });
    await userEvent.click(deleteButtons[1]);
    expect(remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Confirm delete/i }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("smp"));
  });

  it("hides management controls without users:manage", async () => {
    useMeMock.mockReturnValue({ data: { id: 5, username: "reader", permissions: { "*": ["users:read"] } } });
    renderWithQuery(<NetworksTab />);
    await screen.findByText("skyblock");
    expect(screen.queryByLabelText("Network name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove ayse from skyblock" })).not.toBeInTheDocument();
  });
});
