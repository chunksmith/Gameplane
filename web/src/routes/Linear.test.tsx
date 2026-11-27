import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeRepository } from "@/test/factories";

const navigate = vi.fn();
let searchState: { tab?: string; issue?: string } = {};
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string } & Record<string, unknown>) => (
    <a href={to} className={rest.className as string}>{children}</a>
  ),
  useNavigate: () => navigate,
  useSearch: () => searchState,
}));
vi.mock("@/components/assistant/AssistantPanel", () => ({
  AssistantPanel: ({ conversation }: { conversation?: string }) => <div>panel {conversation}</div>,
}));

import { LinearPage } from "./Linear";

const now = new Date().toISOString();
const status = { enabled: true, configured: true, linear: true, defaultModel: "m", defaultEffort: "low", defaultMode: "ask" };
const chk142 = {
  id: "CHK-142", title: "/sethome ignores home limit", status: "Todo", statusType: "unstarted",
  priority: { value: 1, name: "Urgent" }, project: "LitHomes", projectId: "p1", assignee: "arda",
  updatedAt: now, url: "https://linear.app/chunksmith/issue/CHK-142", team: "Chicken", teamId: "t1",
};
const detail = {
  issue: { ...chk142, description: "Players can still set a 6th home.", labels: ["Bug"], createdBy: "mert", createdAt: now },
  comments: [{ id: "k1", body: "Console shows no error.", author: "mert", createdAt: now }],
  run: null,
};

beforeEach(() => {
  navigate.mockClear();
  searchState = {};
  server.use(
    http.get("/ai/status", () => HttpResponse.json(status)),
    http.get("/ai/linear/teams", () => HttpResponse.json([{ id: "t1", key: "CHK", name: "Chicken" }])),
    http.get("/ai/linear/issues", () => HttpResponse.json({ issues: [chk142], cursor: null })),
    http.get("/ai/linear/issues/CHK-142", () => HttpResponse.json(detail)),
    http.get("/ai/linear/links", () => HttpResponse.json([{ projectId: "p1", projectName: "LitHomes", repository: "lithomes", namespace: "gameplane-games" }])),
    http.get("/repositories", () => HttpResponse.json([makeRepository({ name: "lithomes", branch: "main", changes: 0 })])),
  );
});

describe("LinearPage", () => {
  it("lists the assigned issues", async () => {
    renderWithQuery(<LinearPage />);
    expect(await screen.findByText("CHK-142 · /sethome ignores home limit")).toBeInTheDocument();
  });

  it("shows the detail and the linked repository for the selected issue", async () => {
    searchState = { issue: "CHK-142" };
    renderWithQuery(<LinearPage />);
    expect(await screen.findByRole("heading", { name: "CHK-142 · /sethome ignores home limit" })).toBeInTheDocument();
    expect(await screen.findByDisplayValue("Solve CHK-142.")).toBeInTheDocument();
    expect(await screen.findByText("lithomes · main · clean")).toBeInTheDocument();
  });

  it("starts solving in the linked repository", async () => {
    searchState = { issue: "CHK-142" };
    let body: unknown;
    server.use(http.post("/ai/linear/issues/CHK-142/solve", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ conversation: { id: "c1" } }, { status: 201 });
    }));
    renderWithQuery(<LinearPage />);
    await screen.findByText("lithomes · main · clean");
    await userEvent.click(screen.getByRole("button", { name: "Start solving" }));
    await waitFor(() => expect(body).toEqual({ repository: "lithomes", namespace: "gameplane-games", message: "Solve CHK-142." }));
  });

  it("shows the integrations hint when Linear is off", async () => {
    server.use(http.get("/ai/status", () => HttpResponse.json({ ...status, linear: false })));
    renderWithQuery(<LinearPage />);
    expect(await screen.findByText("Connect your Linear API key in Settings → Integrations")).toBeInTheDocument();
  });
});
