import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeFleetItem, makeNetwork, makeServerGrant, makeUser } from "@/test/factories";
import { NETWORK_ANNOTATION } from "@/lib/annotations";
import { UserEditPage } from "./UserEdit";

const routeParams = { id: "2" };
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, ...rest }: { children: ReactNode; to: string; params?: { name: string } } & Record<string, unknown>) => (
    <a href={params ? to.replace("$name", params.name) : to} {...rest}>{children}</a>
  ),
  useNavigate: () => navigate,
  useParams: () => routeParams,
}));

const useMeMock = vi.fn();
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  useMe: () => useMeMock(),
}));

const ME = makeUser({ id: 1, username: "root", displayName: "Root", email: "root@example.com", role: "admin" });
const ALICE = makeUser({ id: 2, username: "alice", displayName: "Alice", email: "alice@example.com", role: "operator" });
const GRANT_TARGET = { userId: 2, cluster: "local", namespace: "gameplane-games" };

function fleetResponse(items: ReturnType<typeof makeFleetItem>[]) {
  return { items, partial: false, issues: [], totalReturned: items.length };
}

beforeEach(() => {
  vi.clearAllMocks();
  routeParams.id = "2";
  useMeMock.mockReturnValue({ data: ME, error: null, isLoading: false });
  server.use(
    http.get("/users", () => HttpResponse.json([ME, ALICE])),
    http.get("/networks", () => HttpResponse.json([
      makeNetwork({ name: "skyblock", members: [{ id: 2, username: "alice", permissions: ["servers:console"] }] }),
      makeNetwork({ name: "smp", members: [] }),
    ])),
    http.get("/server-grants", () => HttpResponse.json([makeServerGrant({ server: "alpha" })])),
    http.get("/fleet/servers", () => HttpResponse.json(fleetResponse([
      makeFleetItem("alpha"),
      makeFleetItem("beta", { [NETWORK_ANNOTATION]: "skyblock" }),
      makeFleetItem("gamma"),
    ]))),
  );
});

describe("UserEditPage profile", () => {
  it("shows a not-found state for an unknown user", async () => {
    routeParams.id = "99";
    renderWithQuery(<UserEditPage />);
    expect(await screen.findByText("User not found")).toBeInTheDocument();
  });

  it("renders the profile fields and the role section", async () => {
    renderWithQuery(<UserEditPage />);
    expect(await screen.findByLabelText("Display name")).toHaveValue("Alice");
    expect(screen.getByLabelText("Email")).toHaveValue("alice@example.com");
    expect(screen.getByDisplayValue("alice")).toBeDisabled();
    expect(await screen.findByText("Cluster & namespace grants")).toBeInTheDocument();
  });

  it("saves profile changes with a PATCH and hides the save bar afterwards", async () => {
    const patches: unknown[] = [];
    server.use(http.patch("/users/:id", async ({ request }) => {
      patches.push(await request.json());
      return HttpResponse.json(ALICE);
    }));
    const user = userEvent.setup();
    renderWithQuery(<UserEditPage />);
    const displayName = await screen.findByLabelText("Display name");
    await user.clear(displayName);
    await user.type(displayName, "Alice Updated");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toEqual([{ displayName: "Alice Updated" }]));
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument());
  });

  it("discards unsaved profile edits", async () => {
    const user = userEvent.setup();
    renderWithQuery(<UserEditPage />);
    const email = await screen.findByLabelText("Email");
    await user.clear(email);
    await user.type(email, "new@example.com");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("alice@example.com");
  });

  it("blocks removing your own user management role", async () => {
    routeParams.id = "1";
    const meAsOperator = { ...ME, role: "operator", permissions: { "*": ["users:manage"] } };
    useMeMock.mockReturnValue({ data: meAsOperator, error: null, isLoading: false });
    server.use(http.get("/users", () => HttpResponse.json([meAsOperator, ALICE])));
    const user = userEvent.setup();
    renderWithQuery(<UserEditPage />);
    await user.click(await screen.findByLabelText(/Primary role/));
    await user.click(await screen.findByRole("option", { name: "viewer" }));
    expect((await screen.findAllByText(/remove your own ability to manage users/i)).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("disables password reset for OIDC accounts", async () => {
    server.use(http.get("/users", () => HttpResponse.json([ME, { ...ALICE, provider: "oidc" }])));
    renderWithQuery(<UserEditPage />);
    expect(await screen.findByRole("button", { name: /Reset password/ })).toBeDisabled();
  });

  it("sets a new password from the reset dialog", async () => {
    const resets: unknown[] = [];
    server.use(http.post("/users/:id/reset-password", async ({ request, params }) => {
      resets.push({ id: params.id, body: await request.json() });
      return new HttpResponse(null, { status: 204 });
    }));
    const user = userEvent.setup();
    renderWithQuery(<UserEditPage />);
    await user.click(await screen.findByRole("button", { name: /Reset password/ }));
    await user.type(await screen.findByPlaceholderText(/At least 12 characters/i), "brand-new-password-1");
    await user.click(screen.getByRole("button", { name: "Set new password" }));
    await waitFor(() => expect(resets).toEqual([{ id: "2", body: { password: "brand-new-password-1" } }]));
  });

  it("deletes the user and returns to the users list", async () => {
    const deleted: string[] = [];
    server.use(http.delete("/users/:id", ({ params }) => {
      deleted.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }));
    const user = userEvent.setup();
    renderWithQuery(<UserEditPage />);
    await user.click(await screen.findByRole("button", { name: "Delete user" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete user" }));
    await waitFor(() => expect(deleted).toEqual(["2"]));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/users" }));
  });
});

describe("UserEditPage server access", () => {
  it("lists direct grants and network servers with their source", async () => {
    renderWithQuery(<UserEditPage />);
    const alpha = (await screen.findByText("alpha")).closest("li") as HTMLElement;
    expect(within(alpha).getByText("Direct")).toBeInTheDocument();
    const beta = screen.getByText("beta").closest("li") as HTMLElement;
    expect(within(beta).getByText("via skyblock")).toBeInTheDocument();
    expect(within(beta).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/users/networks/skyblock");
    const betaGroup = within(beta).getByRole("group", { name: "Permissions for beta" });
    expect(within(betaGroup).getByRole("button", { name: "Console" })).toBeDisabled();
    expect(screen.queryByText("gamma")).not.toBeInTheDocument();
  });

  it("saves a direct grant's permission change immediately", async () => {
    const puts: unknown[] = [];
    server.use(http.put("/server-grants", async ({ request }) => {
      puts.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }));
    const user = userEvent.setup();
    renderWithQuery(<UserEditPage />);
    const group = await screen.findByRole("group", { name: "Permissions for alpha" });
    await user.click(within(group).getByRole("button", { name: "Manage" }));
    await waitFor(() => expect(puts).toEqual([
      { ...GRANT_TARGET, server: "alpha", permissions: ["servers:console", "servers:write"] },
    ]));
  });

  it("removes a direct grant", async () => {
    const removed: URLSearchParams[] = [];
    server.use(http.delete("/server-grants", ({ request }) => {
      removed.push(new URL(request.url).searchParams);
      return new HttpResponse(null, { status: 204 });
    }));
    const user = userEvent.setup();
    renderWithQuery(<UserEditPage />);
    const row = (await screen.findByText("alpha")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: /Remove/ }));
    await waitFor(() => expect(removed).toHaveLength(1));
    expect(Object.fromEntries(removed[0])).toEqual({ userId: "2", cluster: "local", namespace: "gameplane-games", server: "alpha" });
  });

  it("grants the selected servers with the default permissions", async () => {
    const puts: unknown[] = [];
    server.use(http.put("/server-grants", async ({ request }) => {
      puts.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }));
    const user = userEvent.setup();
    renderWithQuery(<UserEditPage />);
    await user.click(await screen.findByRole("button", { name: /Add servers/ }));
    await user.click(screen.getByRole("button", { name: /^gamma/ }));
    await user.click(screen.getByRole("button", { name: "Grant access to 1 server" }));
    await waitFor(() => expect(puts).toEqual([
      { ...GRANT_TARGET, server: "gamma", permissions: ["servers:console"] },
    ]));
  });

  it("applies the permissions chosen for new grants", async () => {
    const puts: unknown[] = [];
    server.use(http.put("/server-grants", async ({ request }) => {
      puts.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }));
    const user = userEvent.setup();
    renderWithQuery(<UserEditPage />);
    await user.click(await screen.findByRole("button", { name: /Add servers/ }));
    const picker = screen.getByRole("group", { name: "Permissions for new server grants" });
    await user.click(within(picker).getByRole("button", { name: "Manage" }));
    await user.click(screen.getByRole("button", { name: /^gamma/ }));
    await user.click(screen.getByRole("button", { name: "Grant access to 1 server" }));
    await waitFor(() => expect(puts).toEqual([
      { ...GRANT_TARGET, server: "gamma", permissions: ["servers:console", "servers:write"] },
    ]));
  });
});

describe("UserEditPage networks", () => {
  it("removes the user from a network", async () => {
    const removed: string[] = [];
    server.use(http.delete("/networks/:name/members/:id", ({ params }) => {
      removed.push(`${params.name}/${params.id}`);
      return new HttpResponse(null, { status: 204 });
    }));
    const user = userEvent.setup();
    renderWithQuery(<UserEditPage />);
    const network = (await screen.findByRole("link", { name: "skyblock" })).closest("li") as HTMLElement;
    await user.click(within(network).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removed).toEqual(["skyblock/2"]));
  });

  it("changes the permissions of a network membership", async () => {
    const puts: unknown[] = [];
    server.use(http.put("/networks/:name/members/:id", async ({ request }) => {
      puts.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }));
    const user = userEvent.setup();
    renderWithQuery(<UserEditPage />);
    const group = await screen.findByRole("group", { name: "Permissions in skyblock" });
    await user.click(within(group).getByRole("button", { name: "Manage" }));
    await waitFor(() => expect(puts).toEqual([{ permissions: ["servers:console", "servers:write"] }]));
  });

  it("adds the user to another network with the chosen permissions", async () => {
    const joins: unknown[] = [];
    server.use(http.put("/networks/:name/members/:id", async ({ request, params }) => {
      joins.push({ name: params.name, id: params.id, body: await request.json() });
      return new HttpResponse(null, { status: 204 });
    }));
    const user = userEvent.setup();
    renderWithQuery(<UserEditPage />);
    const add = await screen.findByRole("button", { name: "Add to network" });
    expect(add).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Network to join/ }));
    await user.click(await screen.findByRole("option", { name: "smp" }));
    await user.click(screen.getByRole("button", { name: "Add to network" }));
    await waitFor(() => expect(joins).toEqual([{ name: "smp", id: "2", body: { permissions: ["servers:console"] } }]));
  });
});
