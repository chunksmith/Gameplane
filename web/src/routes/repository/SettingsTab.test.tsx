import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeRepository } from "@/test/factories";
import type { ResourceTarget } from "@/lib/resourceTarget";
import type { Repository } from "@/types";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => ({ name: "site" }),
  useSearch: () => ({ ns: "gameplane-games" }),
  useNavigate: () => navigate,
}));

import { RepositorySettingsTab } from "./SettingsTab";

const full = ["repositories:read", "repositories:write", "repositories:push", "repositories:manage"];

function renderTab(over: Partial<Repository> = {}, permissions: string[] = full) {
  const repository = makeRepository(over);
  const target: ResourceTarget = { cluster: "local", namespace: repository.namespace, name: repository.name, uid: repository.uid, resource: "repositories" };
  return renderWithQuery(<RepositorySettingsTab repository={repository} target={target} permissions={permissions} />);
}

function fail(status: number, error: string) {
  return HttpResponse.json({ error }, { status });
}

beforeEach(() => navigate.mockClear());

describe("RepositorySettingsTab network", () => {
  it("shows the summary and the current network", async () => {
    renderTab({ network: "lobby", collaborators: 3 });
    expect(await screen.findByText("Network · lobby")).toBeInTheDocument();
    expect(screen.getByText("chunksmith/site")).toBeInTheDocument();
    expect(screen.getByText("2Gi")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("changes the network", async () => {
    const calls: unknown[] = [];
    server.use(http.put(/\/repositories\/[^/]+:network$/, async ({ request }) => {
      calls.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }));
    renderTab();
    expect(await screen.findByText("No network")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Change network" }));
    await userEvent.type(screen.getByRole("combobox", { name: "Network name, empty for none" }), "  lobby ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toEqual([{ network: "lobby" }]));
    expect(await screen.findByRole("button", { name: "Change network" })).toBeInTheDocument();
  });

  it("discards the edit on Cancel", async () => {
    renderTab({ network: "lobby" });
    await userEvent.click(await screen.findByRole("button", { name: "Change network" }));
    const field = screen.getByRole("combobox", { name: "Network name, empty for none" });
    await userEvent.type(field, "x");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Change network" }));
    expect(screen.getByRole("combobox", { name: "Network name, empty for none" })).toHaveValue("lobby");
  });

  it("shows an error when the network cannot be saved", async () => {
    server.use(http.put(/\/repositories\/[^/]+:network$/, () => fail(400, "unknown network")));
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Change network" }));
    await userEvent.type(screen.getByRole("combobox", { name: "Network name, empty for none" }), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("unknown network")).toBeInTheDocument();
  });

  it("hides the management controls without the manage permission", async () => {
    renderTab({}, ["repositories:read"]);
    await screen.findByText("No network");
    expect(screen.queryByRole("button", { name: "Change network" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove repository" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Username" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Edit" })).toBeDisabled();
  });
});

describe("RepositorySettingsTab collaborators", () => {
  it("adds a collaborator by username", async () => {
    const calls: unknown[] = [];
    server.use(http.post("/repositories/:name/collaborators", async ({ request }) => {
      calls.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }));
    renderTab();
    const add = await screen.findByRole("button", { name: "Add collaborator" });
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Username" }), " kaan ");
    await userEvent.click(add);
    await waitFor(() => expect(calls).toEqual([{ username: "kaan", edit: true, push: false }]));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Username" })).toHaveValue(""));
  });

  it("shows an error for an unknown username", async () => {
    server.use(http.post("/repositories/:name/collaborators", () => fail(404, "user not found")));
    renderTab();
    await userEvent.type(await screen.findByRole("textbox", { name: "Username" }), "ghost");
    await userEvent.click(screen.getByRole("button", { name: "Add collaborator" }));
    expect(await screen.findByText("user not found")).toBeInTheDocument();
  });

  it("toggles the edit grant off", async () => {
    const puts: unknown[] = [];
    server.use(http.put("/repositories/:name/collaborators/:userId", async ({ request, params }) => {
      puts.push({ userId: params.userId, body: await request.json() });
      return new HttpResponse(null, { status: 204 });
    }));
    renderTab();
    const group = await screen.findByRole("group", { name: "deniz permissions" });
    expect(within(group).getByRole("button", { name: "Read" })).toBeDisabled();
    await userEvent.click(within(group).getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(puts).toEqual([{ userId: "2", body: { edit: false, push: false } }]));
  });

  it("toggles the push grant on", async () => {
    const puts: unknown[] = [];
    server.use(http.put("/repositories/:name/collaborators/:userId", async ({ request }) => {
      puts.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }));
    renderTab();
    const group = await screen.findByRole("group", { name: "deniz permissions" });
    await userEvent.click(within(group).getByRole("button", { name: "Push" }));
    await waitFor(() => expect(puts).toEqual([{ edit: true, push: true }]));
  });

  it("shows an error when a grant cannot be changed", async () => {
    server.use(http.put("/repositories/:name/collaborators/:userId", () => fail(403, "not allowed")));
    renderTab();
    const group = await screen.findByRole("group", { name: "deniz permissions" });
    await userEvent.click(within(group).getByRole("button", { name: "Push" }));
    expect(await screen.findByText("not allowed")).toBeInTheDocument();
  });

  it("removes a collaborator", async () => {
    const removed: string[] = [];
    server.use(http.delete("/repositories/:name/collaborators/:userId", ({ params }) => {
      removed.push(String(params.userId));
      return new HttpResponse(null, { status: 204 });
    }));
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removed).toEqual(["2"]));
  });

  it("shows an empty state without collaborators", async () => {
    server.use(http.get("/repositories/:name/collaborators", () => HttpResponse.json([])));
    renderTab();
    expect(await screen.findByText("No collaborators yet.")).toBeInTheDocument();
  });

  it("shows an error when the collaborators cannot be loaded", async () => {
    server.use(http.get("/repositories/:name/collaborators", () => fail(500, "list failed")));
    renderTab();
    expect(await screen.findByText("list failed")).toBeInTheDocument();
  });
});

describe("RepositorySettingsTab removal", () => {
  it("removes the repository after typing its name", async () => {
    let removed = 0;
    server.use(http.delete("/repositories/:name", () => {
      removed += 1;
      return new HttpResponse(null, { status: 204 });
    }));
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Remove repository" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Remove repository" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox"), "site");
    await userEvent.click(confirm);
    await waitFor(() => expect(removed).toBe(1));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/repositories" }));
  });

  it("shows an error when the removal fails", async () => {
    server.use(http.delete("/repositories/:name", () => fail(500, "remove failed")));
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Remove repository" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(within(dialog).getByRole("textbox"), "site");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove repository" }));
    expect(await screen.findByText("remove failed")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
