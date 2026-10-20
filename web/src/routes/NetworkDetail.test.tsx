import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeFleetItem, makeNetwork, makeUser } from "@/test/factories";
import { NETWORK_ANNOTATION, OWNER_ANNOTATION } from "@/lib/annotations";
import { NetworkDetailPage } from "./NetworkDetail";

const routeParams = { name: "skyblock" };
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, ...rest }: { children: ReactNode; to: string; params?: { name: string } } & Record<string, unknown>) => (
    <a href={params ? to.replace("$name", params.name) : to} {...rest}>{children}</a>
  ),
  useNavigate: () => navigate,
  useParams: () => routeParams,
}));

const ME = makeUser({ id: 1, username: "root", displayName: "Root", role: "admin" });
const ALICE = makeUser({ id: 2, username: "alice", displayName: "Alice", role: "operator" });
const BOB = makeUser({ id: 3, username: "bob", displayName: "Bob", role: "viewer" });
const CAROL = makeUser({ id: 4, username: "carol", displayName: "Carol", role: "viewer" });

function fleetResponse(items: ReturnType<typeof makeFleetItem>[]) {
  return { items, partial: false, issues: [], totalReturned: items.length };
}

beforeEach(() => {
  vi.clearAllMocks();
  routeParams.name = "skyblock";
  server.use(
    http.get("/networks", () => HttpResponse.json([
      makeNetwork({
        name: "skyblock",
        members: [
          { id: 2, username: "alice", permissions: ["servers:console"] },
          { id: 3, username: "bob", permissions: [] },
        ],
      }),
      makeNetwork({ name: "smp", members: [] }),
    ])),
    http.get("/users", () => HttpResponse.json([ME, ALICE, BOB, CAROL])),
    http.get("/fleet/servers", () => HttpResponse.json(fleetResponse([
      makeFleetItem("alpha", { [NETWORK_ANNOTATION]: "skyblock", [OWNER_ANNOTATION]: "root" }),
      makeFleetItem("beta"),
      makeFleetItem("gamma", { [NETWORK_ANNOTATION]: "smp" }),
    ]))),
  );
});

describe("NetworkDetailPage", () => {
  it("shows a not-found state for an unknown network", async () => {
    routeParams.name = "missing";
    renderWithQuery(<NetworkDetailPage />);
    expect(await screen.findByText("Network not found")).toBeInTheDocument();
  });

  it("lists only the servers assigned to this network with their owner", async () => {
    renderWithQuery(<NetworkDetailPage />);
    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("root")).toBeInTheDocument();
    expect(screen.queryByText("beta")).not.toBeInTheDocument();
    expect(screen.queryByText("gamma")).not.toBeInTheDocument();
  });

  it("unassigns a server from the network", async () => {
    const updates: unknown[] = [];
    server.use(http.put("/servers/:target", async ({ request, params }) => {
      if (!String(params.target).endsWith(":network")) return undefined;
      updates.push({ target: params.target, body: await request.json() });
      return new HttpResponse(null, { status: 204 });
    }));
    const user = userEvent.setup();
    renderWithQuery(<NetworkDetailPage />);
    await user.click(await screen.findByRole("button", { name: "Remove alpha from network" }));
    await waitFor(() => expect(updates).toEqual([{ target: "alpha:network", body: { network: "" } }]));
  });

  it("assigns the selected servers to the network", async () => {
    const updates: unknown[] = [];
    server.use(http.put("/servers/:target", async ({ request, params }) => {
      if (!String(params.target).endsWith(":network")) return undefined;
      updates.push({ target: params.target, body: await request.json() });
      return new HttpResponse(null, { status: 204 });
    }));
    const user = userEvent.setup();
    renderWithQuery(<NetworkDetailPage />);
    await user.click(await screen.findByRole("button", { name: "Add servers" }));
    await user.click(screen.getByRole("button", { name: /^beta/ }));
    await user.click(screen.getByRole("button", { name: "Add 1 server" }));
    await waitFor(() => expect(updates).toEqual([{ target: "beta:network", body: { network: "skyblock" } }]));
  });

  it("changes a member's permissions", async () => {
    const puts: unknown[] = [];
    server.use(http.put("/networks/:name/members/:id", async ({ request, params }) => {
      puts.push({ id: params.id, body: await request.json() });
      return new HttpResponse(null, { status: 204 });
    }));
    const user = userEvent.setup();
    renderWithQuery(<NetworkDetailPage />);
    const group = await screen.findByRole("group", { name: "bob permissions in skyblock" });
    await user.click(within(group).getByRole("button", { name: "Console" }));
    await waitFor(() => expect(puts).toEqual([{ id: "3", body: { permissions: ["servers:console"] } }]));
  });

  it("removes a member", async () => {
    const removed: string[] = [];
    server.use(http.delete("/networks/:name/members/:id", ({ params }) => {
      removed.push(`${params.name}/${params.id}`);
      return new HttpResponse(null, { status: 204 });
    }));
    const user = userEvent.setup();
    renderWithQuery(<NetworkDetailPage />);
    await user.click(await screen.findByRole("button", { name: "Remove alice from skyblock" }));
    await waitFor(() => expect(removed).toEqual(["skyblock/2"]));
  });

  it("adds a member with every server permission", async () => {
    const puts: unknown[] = [];
    server.use(http.put("/networks/:name/members/:id", async ({ request, params }) => {
      puts.push({ name: params.name, id: params.id, body: await request.json() });
      return new HttpResponse(null, { status: 204 });
    }));
    const user = userEvent.setup();
    renderWithQuery(<NetworkDetailPage />);
    await user.click(await screen.findByRole("button", { name: /User to add/ }));
    await user.click(await screen.findByRole("option", { name: "carol" }));
    await user.click(screen.getByRole("button", { name: /Add member/ }));
    await waitFor(() => expect(puts).toEqual([
      { name: "skyblock", id: "4", body: { permissions: ["servers:console", "servers:write"] } },
    ]));
  });

  it("unassigns the servers and deletes the network after confirmation", async () => {
    const updates: unknown[] = [];
    const deleted: string[] = [];
    server.use(
      http.put("/servers/:target", async ({ request, params }) => {
        if (!String(params.target).endsWith(":network")) return undefined;
        updates.push({ target: params.target, body: await request.json() });
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete("/networks/:name", ({ params }) => {
        deleted.push(String(params.name));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderWithQuery(<NetworkDetailPage />);
    await user.click(await screen.findByRole("button", { name: "Delete network" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete network" }));
    await waitFor(() => expect(deleted).toEqual(["skyblock"]));
    expect(updates).toEqual([{ target: "alpha:network", body: { network: "" } }]);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/users", search: { tab: "networks" } }));
  });
});
