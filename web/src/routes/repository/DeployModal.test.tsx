import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeBuild, makeDeployment, makeFileEntry, makeFleetItem, makeRepository } from "@/test/factories";
import { DeployModal } from "./DeployModal";

const repository = makeRepository();
const build = makeBuild();

function writable(name: string, canWrite: boolean) {
  return { ...makeFleetItem(name), access: { canWrite, canControl: canWrite, canConsole: canWrite, canDelete: false, isOwner: false, isCollaborator: canWrite } };
}

function renderModal(onClose = vi.fn()) {
  return renderWithQuery(<DeployModal repository={repository} build={build} artifactPath={build.artifacts[0].path} onAskAssistant={vi.fn()} onClose={onClose} />);
}

describe("DeployModal", () => {
  it("lists only servers the user can write", async () => {
    server.use(http.get("/fleet/servers", () => HttpResponse.json({
      items: [writable("spawn-1", true), writable("vault", false)],
      partial: false,
      issues: [],
      totalReturned: 2,
    })));
    renderModal();
    expect(await screen.findByText("spawn-1")).toBeInTheDocument();
    expect(screen.queryByText("vault")).not.toBeInTheDocument();
  });

  it("suggests old jars from the folder and deploys the picked servers", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.get("/fleet/servers", () => HttpResponse.json({ items: [writable("spawn-1", true)], partial: false, issues: [], totalReturned: 1 })),
      http.get("/servers/:name/files/list", () => HttpResponse.json([makeFileEntry({ name: "site-0.9.2.jar", path: "/plugins/site-0.9.2.jar" })])),
      http.post("/repositories/:name/builds/:number/deploy", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ deployment: makeDeployment({ targets: [{ cluster: "local", namespace: "gameplane-games", server: "spawn-1", ok: true, error: null }] }) });
      }),
    );
    renderModal();
    await userEvent.click(await screen.findByText("spawn-1"));
    expect(await screen.findByRole("button", { name: "site-0.9.2.jar" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Deploy to 1 server" }));
    await waitFor(() => expect(bodies).toEqual([{
      artifact: "target/site-1.0.0.jar",
      targets: [{ cluster: "local", namespace: "gameplane-games", server: "spawn-1" }],
      dir: "plugins",
      filename: "site-1.0.0.jar",
      remove: ["site-0.9.2.jar"],
      restart: false,
    }]));
    expect(await screen.findByText("1 / 1 written")).toBeInTheDocument();
  });
});
