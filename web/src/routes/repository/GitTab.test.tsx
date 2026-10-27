import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeGitHub, makeGitStatus, makeRepository } from "@/test/factories";
import type { ResourceTarget } from "@/lib/resourceTarget";
import { GitTab } from "./GitTab";

const repository = makeRepository();
const target: ResourceTarget = { cluster: "local", namespace: repository.namespace, name: repository.name, uid: repository.uid, resource: "repositories" };
const full = ["repositories:read", "repositories:write", "repositories:push", "repositories:manage"];

function renderTab(permissions: string[] = full) {
  return renderWithQuery(<GitTab repository={repository} target={target} permissions={permissions} />);
}

function problem(status: number, body: Record<string, unknown>) {
  return HttpResponse.json({ type: "about:blank", title: "Error", status, ...body }, { status, headers: { "Content-Type": "application/problem+json" } });
}

function capture(method: "post" | "get", path: string, calls: unknown[]) {
  server.use(http[method](path, async ({ request }) => {
    calls.push(await request.json());
    return HttpResponse.json(makeGitStatus());
  }));
}

async function fillCommit(summary: string, description?: string) {
  await userEvent.type(await screen.findByRole("textbox", { name: "Summary" }), summary);
  if (description) await userEvent.type(screen.getByRole("textbox", { name: "Description (optional)" }), description);
}

describe("GitTab changes", () => {
  it("stages every change at once", async () => {
    const calls: unknown[] = [];
    capture("post", "/repositories/:name/git/stage", calls);
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Stage all" }));
    await waitFor(() => expect(calls).toEqual([{ paths: "all" }]));
  });

  it("unstages every staged file at once", async () => {
    const calls: unknown[] = [];
    capture("post", "/repositories/:name/git/unstage", calls);
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Unstage all" }));
    await waitFor(() => expect(calls).toEqual([{ paths: "all" }]));
  });

  it("unstages a single file from its diff", async () => {
    const calls: unknown[] = [];
    capture("post", "/repositories/:name/git/unstage", calls);
    renderTab();
    await userEvent.click(await screen.findByText("build.gradle.kts"));
    expect(await screen.findByText("+new: 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Unstage file" }));
    await waitFor(() => expect(calls).toEqual([{ paths: ["build.gradle.kts"] }]));
  });

  it("discards one file after confirming", async () => {
    const calls: unknown[] = [];
    capture("post", "/repositories/:name/git/discard", calls);
    renderTab();
    await userEvent.click(await screen.findByText("config.yml"));
    await userEvent.click(await screen.findByRole("button", { name: "Discard" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Discard config.yml?")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(calls).toEqual([{ paths: ["config.yml"] }]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByText("Select a file to see its changes.")).toBeInTheDocument();
  });

  it("discards all unstaged changes after confirming", async () => {
    const calls: unknown[] = [];
    capture("post", "/repositories/:name/git/discard", calls);
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Discard all" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Discard all changes?")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(calls).toEqual([{ paths: ["config.yml", "CHANGELOG.md"] }]));
  });

  it("keeps the changes when the discard dialog is cancelled", async () => {
    const calls: unknown[] = [];
    capture("post", "/repositories/:name/git/discard", calls);
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Discard all" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(calls).toEqual([]);
  });

  it("goes back from a diff to the empty panel", async () => {
    renderTab();
    await userEvent.click(await screen.findByText("config.yml"));
    expect(await screen.findByText("+new: 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Changes" }));
    expect(await screen.findByText("Select a file to see its changes.")).toBeInTheDocument();
  });

  it("shows an empty state when the working copy is clean", async () => {
    server.use(http.get("/repositories/:name/git/status", () => HttpResponse.json(makeGitStatus({ changes: [] }))));
    renderTab();
    expect(await screen.findByText("No uncommitted changes.")).toBeInTheDocument();
  });

  it("commits with the summary and description and clears the fields", async () => {
    const calls: unknown[] = [];
    server.use(http.post("/repositories/:name/git/commit", async ({ request }) => {
      calls.push(await request.json());
      return HttpResponse.json({ commit: { sha: "1", subject: "x", body: "", author: "a", login: null, time: "2026-10-27T10:00:00Z", pushed: false }, pushed: false });
    }));
    renderTab();
    await fillCommit("  Raise max-sight  ", "Longer view");
    expect(screen.getByText("Commits and pushes use your own GitHub token (@arda).")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Commit 1 file" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Commit 1 file" }));
    await waitFor(() => expect(calls).toEqual([{ summary: "Raise max-sight", description: "Longer view", push: false }]));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Summary" })).toHaveValue(""));
    expect(screen.getByRole("textbox", { name: "Description (optional)" })).toHaveValue("");
  });

  it("commits and pushes in one step", async () => {
    const calls: unknown[] = [];
    server.use(http.post("/repositories/:name/git/commit", async ({ request }) => {
      calls.push(await request.json());
      return HttpResponse.json({ commit: { sha: "1", subject: "x", body: "", author: "a", login: null, time: "2026-10-27T10:00:00Z", pushed: true }, pushed: true });
    }));
    renderTab();
    await fillCommit("Ship it");
    await waitFor(() => expect(screen.getByRole("button", { name: "Commit & push" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Commit & push" }));
    await waitFor(() => expect(calls).toEqual([{ summary: "Ship it", push: true }]));
  });

  it("hides Commit & push without the push permission", async () => {
    renderTab(["repositories:read", "repositories:write"]);
    await screen.findByRole("textbox", { name: "Summary" });
    expect(screen.queryByRole("button", { name: "Commit & push" })).not.toBeInTheDocument();
  });

  it("blocks committing and explains when no GitHub token is connected", async () => {
    server.use(http.get("/integrations/github", () => HttpResponse.json(makeGitHub({ keySet: false, login: null }))));
    renderTab();
    expect(await screen.findByText("Connect your GitHub token in Settings, Integrations to commit and push.")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Summary" }), "No token");
    expect(screen.getByRole("button", { name: "Commit 1 file" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Commit & push" })).toBeDisabled();
  });

  it("maps 428 github_token_required to the connect-your-token text", async () => {
    server.use(http.post("/repositories/:name/git/commit", () => problem(428, {
      detail: "Connect your GitHub token in Settings, Integrations first.",
      messageId: "server.repositories.github_token_required",
      args: {},
      code: "github_token_required",
    })));
    renderTab();
    await fillCommit("Needs token");
    await waitFor(() => expect(screen.getByRole("button", { name: "Commit 1 file" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Commit 1 file" }));
    expect(await screen.findByText("Connect your GitHub token in Settings, Integrations first.")).toBeInTheDocument();
  });

  it("lists the conflicted files of a 409 conflict", async () => {
    server.use(http.post("/repositories/:name/git/fetch", () => problem(409, {
      detail: "The changes conflict and were not applied.",
      messageId: "server.repositories.conflict",
      args: {},
      code: "conflict",
      files: ["a.txt", "b.txt"],
    })));
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Fetch" }));
    expect(await screen.findByText(/a\.txt, b\.txt/)).toBeInTheDocument();
  });

  it("shows a status error", async () => {
    server.use(http.get("/repositories/:name/git/status", () => HttpResponse.json({ error: "git is unavailable" }, { status: 500 })));
    renderTab();
    expect(await screen.findByText("git is unavailable")).toBeInTheDocument();
  });

  it("shows an error when a diff cannot be loaded", async () => {
    server.use(http.get("/repositories/:name/git/diff", () => new HttpResponse("diff unreadable", { status: 500 })));
    renderTab();
    await userEvent.click(await screen.findByText("config.yml"));
    expect(await screen.findByText("diff unreadable")).toBeInTheDocument();
  });
});

describe("GitTab branches", () => {
  it("creates a branch and checks it out", async () => {
    const calls: unknown[] = [];
    server.use(http.post("/repositories/:name/git/branches", async ({ request }) => {
      calls.push(await request.json());
      return HttpResponse.json({ name: "feature/x", current: true, upstream: null, ahead: 0, behind: 0 });
    }));
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "New branch" }));
    const create = await screen.findByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Branch name" }), "feature/x");
    await userEvent.click(create);
    await waitFor(() => expect(calls).toEqual([{ name: "feature/x", checkout: true }]));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Branch name" })).not.toBeInTheDocument());
  });

  it("rejects an invalid branch name", async () => {
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "New branch" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Branch name" }), "-bad name");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("creates the branch on Enter and closes on Cancel", async () => {
    const calls: unknown[] = [];
    server.use(http.post("/repositories/:name/git/branches", async ({ request }) => {
      calls.push(await request.json());
      return HttpResponse.json({ name: "hotfix", current: true, upstream: null, ahead: 0, behind: 0 });
    }));
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "New branch" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Branch name" }), "hotfix{Enter}");
    await waitFor(() => expect(calls).toEqual([{ name: "hotfix", checkout: true }]));
    await userEvent.click(await screen.findByRole("button", { name: "New branch" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Branch name" })).not.toBeInTheDocument());
    expect(calls).toHaveLength(1);
  });

  it("offers remote-only branches and checks one out", async () => {
    const calls: unknown[] = [];
    capture("post", "/repositories/:name/git/checkout", calls);
    server.use(http.get("/repositories/:name/git/branches", () => HttpResponse.json([
      { name: "main", current: true, upstream: "origin/main", ahead: 0, behind: 0 },
      { name: "origin/main", current: false, upstream: null, ahead: 0, behind: 0 },
      { name: "origin/dev", current: false, upstream: null, ahead: 0, behind: 0 },
    ])));
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: /Branch/ }));
    expect(screen.queryByRole("option", { name: "origin/main" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("option", { name: "origin/dev" }));
    await waitFor(() => expect(calls).toEqual([{ branch: "origin/dev" }]));
  });

  it("shows when the branch has no upstream", async () => {
    server.use(http.get("/repositories/:name/git/status", () => HttpResponse.json(makeGitStatus({ upstream: null }))));
    renderTab();
    expect(await screen.findByText("not pushed yet")).toBeInTheDocument();
  });
});

describe("GitTab history", () => {
  async function openHistory() {
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "History" }));
  }

  it("shows the commit detail with its file count and how many commits to pull", async () => {
    await openHistory();
    expect(await screen.findByText("↓2 to pull")).toBeInTheDocument();
    expect(screen.getByText("Select a commit to see it.")).toBeInTheDocument();
    await userEvent.click(await screen.findByText("Enable model cache"));
    expect(await screen.findByText(/@kaan · .* · 1 file/)).toBeInTheDocument();
    expect(screen.getByText("e41b7d0")).toBeInTheDocument();
    expect(await screen.findByText("+b")).toBeInTheDocument();
  });

  it("undoes the last unpushed commit", async () => {
    let undone = 0;
    server.use(http.post("/repositories/:name/git/undo", () => {
      undone += 1;
      return HttpResponse.json(makeGitStatus());
    }));
    await openHistory();
    await userEvent.click(await screen.findByRole("button", { name: "Undo last commit" }));
    await waitFor(() => expect(undone).toBe(1));
  });

  it("reverts the selected commit", async () => {
    const calls: unknown[] = [];
    server.use(http.post("/repositories/:name/git/revert", async ({ request }) => {
      calls.push(await request.json());
      return HttpResponse.json({ commit: { sha: "2", subject: "Revert", body: "", author: "a", login: null, time: "2026-10-27T10:00:00Z", pushed: false } });
    }));
    await openHistory();
    await userEvent.click(await screen.findByText("Enable model cache"));
    await userEvent.click(await screen.findByRole("button", { name: "Revert commit" }));
    await waitFor(() => expect(calls).toEqual([{ sha: "e41b7d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }]));
  });

  it("shows an error when the commit cannot be loaded", async () => {
    server.use(http.get("/repositories/:name/git/commits/:sha", () => HttpResponse.json({ error: "commit missing" }, { status: 404 })));
    await openHistory();
    await userEvent.click(await screen.findByText("Enable model cache"));
    expect(await screen.findByText("commit missing")).toBeInTheDocument();
  });

  it("lists pushed commits of the branch when there is no upstream", async () => {
    server.use(http.get("/repositories/:name/git/status", () => HttpResponse.json(makeGitStatus({ upstream: null, behind: 0 }))));
    await openHistory();
    expect(await screen.findByText("Bump version")).toBeInTheDocument();
    expect(screen.queryByText(/to pull/)).not.toBeInTheDocument();
  });

  it("disables undo and revert without the write permission", async () => {
    renderTab(["repositories:read"]);
    await userEvent.click(await screen.findByRole("button", { name: "History" }));
    expect(await screen.findByRole("button", { name: "Undo last commit" })).toBeDisabled();
    await userEvent.click(await screen.findByText("Enable model cache"));
    expect(await screen.findByRole("button", { name: "Revert commit" })).toBeDisabled();
  });
});
