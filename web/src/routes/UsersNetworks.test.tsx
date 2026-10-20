import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeFleetItem, makeNetwork } from "@/test/factories";
import { NETWORK_ANNOTATION } from "@/lib/annotations";
import { NetworksTab } from "./UsersNetworks";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, ...rest }: { children: ReactNode; to: string; params?: { name: string } } & Record<string, unknown>) => (
    <a href={params ? to.replace("$name", params.name) : to} {...rest}>{children}</a>
  ),
}));

const useMeMock = vi.fn();
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  useMe: () => useMeMock(),
}));

const ADMIN = { id: 1, username: "root", permissions: { "*": ["*"] } };
const READER = { id: 5, username: "reader", permissions: { "*": ["users:read"] } };

const skyblockServers = ["s1", "s2", "s3", "s4", "s5", "s6"].map((name) => makeFleetItem(name, { [NETWORK_ANNOTATION]: "skyblock" }));
const fleetItems = [
  ...skyblockServers,
  makeFleetItem("alpha", { [NETWORK_ANNOTATION]: "skyblock" }),
  makeFleetItem("beta"),
];

function serveNetworks(networks: ReturnType<typeof makeNetwork>[]) {
  server.use(http.get("/networks", () => HttpResponse.json(networks)));
}

function serveFleet() {
  server.use(http.get("/fleet/servers", () => HttpResponse.json({ items: fleetItems, partial: false, issues: [], totalReturned: fleetItems.length })));
}

beforeEach(() => {
  useMeMock.mockReturnValue({ data: ADMIN });
  serveNetworks([
    makeNetwork({ name: "skyblock", members: [{ id: 2, username: "ayse", permissions: ["servers:console"] }] }),
    makeNetwork({ name: "smp", members: [] }),
  ]);
  serveFleet();
});

describe("NetworksTab", () => {
  it("lists each network with its server and member counts", async () => {
    renderWithQuery(<NetworksTab />);
    expect(await screen.findByRole("link", { name: "skyblock" })).toHaveAttribute("href", "/users/networks/skyblock");
    expect(screen.getByText("7 servers")).toBeInTheDocument();
    expect(screen.getByText("1 member")).toBeInTheDocument();
    expect(screen.getByText("0 members")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add servers/ })).toHaveAttribute("href", "/users/networks/smp");
  });

  it("shows the first four server chips and the number of the rest", async () => {
    renderWithQuery(<NetworksTab />);
    await screen.findByRole("link", { name: "skyblock" });
    expect(screen.getByText("s1")).toBeInTheDocument();
    expect(screen.getByText("s4")).toBeInTheDocument();
    expect(screen.queryByText("s5")).not.toBeInTheDocument();
    expect(screen.getByText("+3")).toBeInTheDocument();
  });

  it("shows an empty state when there are no networks", async () => {
    serveNetworks([]);
    renderWithQuery(<NetworksTab />);
    expect(await screen.findByText("No networks yet.")).toBeInTheDocument();
  });

  it("filters the network cards by name", async () => {
    renderWithQuery(<NetworksTab />);
    await screen.findByRole("link", { name: "smp" });
    await userEvent.type(screen.getByLabelText("Search networks"), "sky");
    expect(screen.getByRole("link", { name: "skyblock" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "smp" })).not.toBeInTheDocument();
  });

  it("shows a no-match state when the search matches nothing", async () => {
    renderWithQuery(<NetworksTab />);
    await screen.findByRole("link", { name: "smp" });
    await userEvent.type(screen.getByLabelText("Search networks"), "zzz");
    expect(await screen.findByText("No networks match your search.")).toBeInTheDocument();
  });

  it("creates a network from the dialog", async () => {
    const created: unknown[] = [];
    server.use(http.post("/networks", async ({ request }) => {
      created.push(await request.json());
      return HttpResponse.json({ name: "survival", members: [] }, { status: 201 });
    }));
    renderWithQuery(<NetworksTab />);
    await userEvent.click(await screen.findByRole("button", { name: /New network/i }));
    await userEvent.type(await screen.findByLabelText("Network name"), "survival");
    await userEvent.click(screen.getByRole("button", { name: /^Create$/i }));
    await waitFor(() => expect(created).toEqual([{ name: "survival" }]));
  });

  it("hides the new network button without users:manage", async () => {
    useMeMock.mockReturnValue({ data: READER });
    renderWithQuery(<NetworksTab />);
    await screen.findByRole("link", { name: "skyblock" });
    expect(screen.queryByRole("button", { name: /New network/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Manage/ })).toHaveLength(2);
  });
});
