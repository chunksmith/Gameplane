import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeServer } from "@/test/factories";
import { AccessSection } from "./Access";
import { ResourceTargetProvider, type ServerAccess } from "@/lib/resourceTarget";

vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  useMe: () => ({ data: { id: 1, username: "alice", permissions: {} } }),
}));

const OWNER: ServerAccess = { canWrite: false, canControl: true, canConsole: true, canDelete: true, isOwner: true, isCollaborator: false, permissions: [] };
const MEMBER: ServerAccess = { canWrite: false, canControl: true, canConsole: true, canDelete: false, isOwner: false, isCollaborator: true, permissions: [] };

function renderAccess(annotations: Record<string, string>, access: ServerAccess) {
  const gs = makeServer({
    metadata: { name: "test", namespace: "ns", annotations: { "gameplane.local/owner": "alice", "gameplane.local/owner-id": "1", ...annotations } },
    spec: { templateRef: { name: "mc" } },
  });
  renderWithQuery(
    <ResourceTargetProvider target={{ cluster: "remote", namespace: "ns", name: "test", uid: gs.metadata.uid }} access={access}>
      <AccessSection gs={gs} />
    </ResourceTargetProvider>,
  );
}

describe("AccessSection network", () => {
  let requestBody: unknown;
  let requestURL: string;

  beforeEach(() => {
    requestBody = undefined;
    requestURL = "";
    server.use(
      http.put("/servers/test:network", async ({ request }) => {
        requestURL = request.url;
        requestBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
  });

  it("shows when the server is not in a network", () => {
    renderAccess({}, OWNER);
    expect(screen.getByText("Not in a network")).toBeInTheDocument();
  });

  it("lets the owner assign a network", async () => {
    renderAccess({}, OWNER);
    await userEvent.type(screen.getByPlaceholderText(/Assign to network/i), "skyblock");
    await userEvent.click(screen.getByRole("button", { name: /^Assign$/i }));
    await waitFor(() => expect(requestBody).toEqual({ network: "skyblock" }));
    expect(new URL(requestURL).searchParams.get("namespace")).toBe("ns");
    expect(new URL(requestURL).searchParams.get("cluster")).toBe("remote");
  });

  it("lets the owner clear the network", async () => {
    renderAccess({ "gameplane.local/network": "skyblock" }, OWNER);
    expect(screen.getByText("skyblock")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove from network" }));
    await waitFor(() => expect(requestBody).toEqual({ network: "" }));
  });

  it("shows the network read-only to collaborators", () => {
    renderAccess({ "gameplane.local/network": "skyblock" }, MEMBER);
    expect(screen.getByText("skyblock")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Assign to network/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove from network" })).not.toBeInTheDocument();
  });

  it("shows the API error", async () => {
    server.use(http.put("/servers/test:network", () => new HttpResponse("network not found", { status: 400 })));
    renderAccess({}, OWNER);
    await userEvent.type(screen.getByPlaceholderText(/Assign to network/i), "ghost{Enter}");
    expect(await screen.findByText(/network not found/i)).toBeInTheDocument();
  });
});
