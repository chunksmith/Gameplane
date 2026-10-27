import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeGitHub } from "@/test/factories";
import type { GitHubIntegration } from "@/types";
import { GitHubCard } from "./GitHubCard";

function serve(over: Partial<GitHubIntegration>) {
  server.use(http.get("/integrations/github", () => HttpResponse.json(makeGitHub(over))));
}

function captureToken(tokens: unknown[]) {
  server.use(http.put("/integrations/github/token", async ({ request }) => {
    tokens.push(await request.json());
    return HttpResponse.json(makeGitHub());
  }));
}

describe("GitHubCard", () => {
  it("shows the connected account, masked token and permissions", async () => {
    renderWithQuery(<GitHubCard />);
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("github_pat_••••••••7c2e")).toBeInTheDocument();
    expect(screen.getByText("Signed in as @arda")).toBeInTheDocument();
    expect(screen.getByText("Read & write")).toBeInTheDocument();
    expect(screen.getByText("Not granted")).toBeInTheDocument();
  });

  it("shows read-only contents and granted workflows", async () => {
    serve({ contents: "read", workflows: true });
    renderWithQuery(<GitHubCard />);
    expect(await screen.findByText("Read only")).toBeInTheDocument();
    expect(screen.getByText("Granted")).toBeInTheDocument();
  });

  it("shows permissions a token does not report", async () => {
    serve({ contents: null, workflows: null });
    renderWithQuery(<GitHubCard />);
    expect(await screen.findAllByText("Not reported")).toHaveLength(2);
  });

  it("shows no contents access when none is granted", async () => {
    serve({ contents: "none", workflows: false });
    renderWithQuery(<GitHubCard />);
    expect(await screen.findAllByText("Not granted")).toHaveLength(2);
  });

  it("connects a token when none is stored", async () => {
    serve({ keySet: false, keyHint: "", login: null, name: null, contents: null, workflows: null });
    const tokens: unknown[] = [];
    captureToken(tokens);
    renderWithQuery(<GitHubCard />);
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Add token" }));
    const save = screen.getByRole("button", { name: "Save token" });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText("GitHub token"), "  github_pat_new  ");
    await userEvent.click(save);
    await waitFor(() => expect(tokens).toEqual([{ token: "github_pat_new" }]));
    await waitFor(() => expect(screen.queryByLabelText("GitHub token")).not.toBeInTheDocument());
  });

  it("replaces the stored token", async () => {
    const tokens: unknown[] = [];
    captureToken(tokens);
    renderWithQuery(<GitHubCard />);
    await userEvent.click(await screen.findByRole("button", { name: "Replace" }));
    expect(screen.queryByText("github_pat_••••••••7c2e")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("GitHub token"), "github_pat_other");
    await userEvent.click(screen.getByRole("button", { name: "Save token" }));
    await waitFor(() => expect(tokens).toEqual([{ token: "github_pat_other" }]));
  });

  it("cancels editing without saving", async () => {
    const tokens: unknown[] = [];
    captureToken(tokens);
    renderWithQuery(<GitHubCard />);
    await userEvent.click(await screen.findByRole("button", { name: "Replace" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Replace" })).toBeInTheDocument();
    expect(tokens).toEqual([]);
  });

  it("removes the stored token", async () => {
    let removed = 0;
    server.use(http.delete("/integrations/github/token", () => {
      removed += 1;
      return new HttpResponse(null, { status: 204 });
    }));
    renderWithQuery(<GitHubCard />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removed).toBe(1));
  });

  it("shows an error for an invalid token", async () => {
    server.use(http.put("/integrations/github/token", () => HttpResponse.json({ error: "GitHub rejected the token" }, { status: 400 })));
    renderWithQuery(<GitHubCard />);
    await userEvent.click(await screen.findByRole("button", { name: "Replace" }));
    await userEvent.type(screen.getByLabelText("GitHub token"), "bad");
    await userEvent.click(screen.getByRole("button", { name: "Save token" }));
    expect(await screen.findByText("GitHub rejected the token")).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub token")).toBeInTheDocument();
  });

  it("shows an error when the token cannot be removed", async () => {
    server.use(http.delete("/integrations/github/token", () => HttpResponse.json({ error: "remove denied" }, { status: 500 })));
    renderWithQuery(<GitHubCard />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByText("remove denied")).toBeInTheDocument();
  });
});
