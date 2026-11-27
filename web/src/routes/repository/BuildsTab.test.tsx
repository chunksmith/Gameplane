import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeBuild, makeBuildList, makeRepository } from "@/test/factories";
import { BuildsTab } from "./BuildsTab";

const repository = makeRepository();

function renderTab(canWrite = true) {
  return renderWithQuery(<BuildsTab repository={repository} canWrite={canWrite} onAskAssistant={vi.fn()} />);
}

describe("BuildsTab", () => {
  it("opens the artifacts of the build picked from the list", async () => {
    server.use(http.get("/repositories/:name/builds", () => HttpResponse.json(makeBuildList({
      builds: [makeBuild({ number: 15, phase: "Running", artifacts: [] }), makeBuild()],
    }))));
    renderTab();
    expect((await screen.findAllByText("#15 · Running")).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: /#14/ }));
    expect(await screen.findByText("target/site-1.0.0.jar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deploy to servers…" })).toBeInTheDocument();
  });

  it("hides write actions without repositories:write", async () => {
    renderTab(false);
    await screen.findAllByText("#14 · Succeeded");
    expect(screen.queryByRole("button", { name: "Build" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear cache" })).not.toBeInTheDocument();
  });

  it("starts a build with the repository defaults", async () => {
    const bodies: unknown[] = [];
    server.use(http.post("/repositories/:name/builds", async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(makeBuild({ number: 15, phase: "Queued", artifacts: [] }), { status: 201 });
    }));
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Build" }));
    await waitFor(() => expect(bodies).toEqual([{}]));
  });

  it("shows the log of a finished build", async () => {
    renderTab();
    expect(await screen.findByText(/BUILD SUCCESS/)).toBeInTheDocument();
  });
});
