import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeRepository } from "@/test/factories";

const navigate = vi.fn();
let routeParams: Record<string, string> = { name: "site" };
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => routeParams,
  useSearch: () => ({ ns: "gameplane-games" }),
  useNavigate: () => navigate,
}));

vi.mock("./tabs/Files", () => ({ FilesTab: ({ path }: { path: string }) => <div>files-tab {path}</div> }));

import { RepositoryDetailPage } from "./RepositoryDetail";

function grant(permissions: string[]) {
  server.use(http.get("/repositories/:name/access", () => HttpResponse.json({ isOwner: false, isCollaborator: true, permissions })));
}

beforeEach(() => {
  routeParams = { name: "site" };
  navigate.mockClear();
});

describe("RepositoryDetailPage", () => {
  it("shows the header and the Git changes", async () => {
    renderWithQuery(<RepositoryDetailPage />);
    expect(await screen.findByRole("heading", { name: "site" })).toBeInTheDocument();
    expect(await screen.findByText("Staged · 1")).toBeInTheDocument();
    expect(screen.getByText("Changes · 2")).toBeInTheDocument();
    expect(screen.getByText("build.gradle.kts")).toBeInTheDocument();
    expect(screen.getByText("CHANGELOG.md")).toBeInTheDocument();
  });

  it("shows a file diff and stages it", async () => {
    const stages: unknown[] = [];
    server.use(http.post("/repositories/:name/git/stage", async ({ request }) => {
      stages.push(await request.json());
      return HttpResponse.json({ branch: "main", head: null, upstream: null, ahead: 0, behind: 0, changes: [] });
    }));
    renderWithQuery(<RepositoryDetailPage />);
    await userEvent.click(await screen.findByText("config.yml"));
    expect(await screen.findByText("+new: 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stage file" }));
    await waitFor(() => expect(stages).toEqual([{ paths: ["config.yml"] }]));
  });

  it("commits the staged files", async () => {
    const commits: unknown[] = [];
    server.use(http.post("/repositories/:name/git/commit", async ({ request }) => {
      commits.push(await request.json());
      return HttpResponse.json({ commit: { sha: "1", subject: "x", body: "", author: "a", login: null, time: "2026-10-27T10:00:00Z", pushed: false }, pushed: false });
    }));
    renderWithQuery(<RepositoryDetailPage />);
    await userEvent.type(await screen.findByRole("textbox", { name: "Summary" }), "Raise max-sight");
    await waitFor(() => expect(screen.getByRole("button", { name: "Commit 1 file" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Commit 1 file" }));
    await waitFor(() => expect(commits).toEqual([{ summary: "Raise max-sight", push: false }]));
  });

  it("explains a conflicted pull with the files", async () => {
    server.use(http.post("/repositories/:name/git/pull", () => HttpResponse.json(
      { type: "about:blank", status: 409, title: "Conflict", detail: "The changes conflict and were not applied.", messageId: "server.repositories.conflict", args: {}, code: "conflict", files: ["a.txt", "b.txt"] },
      { status: 409, headers: { "Content-Type": "application/problem+json" } },
    )));
    renderWithQuery(<RepositoryDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Pull" }));
    expect(await screen.findByText(/a\.txt, b\.txt/)).toBeInTheDocument();
  });

  it("disables Push and the commit box without the matching permissions", async () => {
    grant(["repositories:read"]);
    renderWithQuery(<RepositoryDetailPage />);
    await screen.findByText("Staged · 1");
    expect(screen.getByRole("button", { name: "Push" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
    expect(screen.queryByRole("textbox", { name: "Summary" })).not.toBeInTheDocument();
  });

  it("shows clone progress while the repository is cloning", async () => {
    server.use(http.get("/repositories/:name", () => HttpResponse.json(makeRepository({ phase: "Cloning", cloneProgress: 42 }))));
    renderWithQuery(<RepositoryDetailPage />);
    expect(await screen.findByText("Cloning… 42%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Clone progress" })).toHaveAttribute("aria-valuenow", "42");
  });

  it("lists commits and reverts the selected one", async () => {
    const reverts: unknown[] = [];
    server.use(http.post("/repositories/:name/git/revert", async ({ request }) => {
      reverts.push(await request.json());
      return HttpResponse.json({ commit: { sha: "2", subject: "Revert", body: "", author: "a", login: null, time: "2026-10-27T10:00:00Z", pushed: false } });
    }));
    renderWithQuery(<RepositoryDetailPage />);
    await userEvent.click(await screen.findByRole("button", { name: "History" }));
    expect(await screen.findByText("Not pushed · 1")).toBeInTheDocument();
    await userEvent.click(await screen.findByText("Fix lerp"));
    await userEvent.click(await screen.findByRole("button", { name: "Revert commit" }));
    await waitFor(() => expect(reverts).toEqual([{ sha: "9bd02e4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }]));
  });

  it("changes a collaborator's push grant in Settings", async () => {
    const puts: unknown[] = [];
    server.use(http.put("/repositories/:name/collaborators/:userId", async ({ request, params }) => {
      puts.push({ userId: params.userId, body: await request.json() });
      return new HttpResponse(null, { status: 204 });
    }));
    renderWithQuery(<RepositoryDetailPage />);
    await userEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    const group = await screen.findByRole("group", { name: "deniz permissions" });
    await userEvent.click(within(group).getByRole("button", { name: "Push" }));
    await waitFor(() => expect(puts).toEqual([{ userId: "2", body: { edit: true, push: true } }]));
  });
});
