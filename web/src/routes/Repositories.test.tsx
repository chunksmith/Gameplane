import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeGitHub, makeRepository, makeUser } from "@/test/factories";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string } & Record<string, unknown>) => (
    <a href={to} className={rest.className as string}>{children}</a>
  ),
  useNavigate: () => navigate,
}));

import { RepositoriesPage } from "./Repositories";

beforeEach(() => navigate.mockClear());

describe("RepositoriesPage", () => {
  it("lists repositories with their Git state", async () => {
    server.use(http.get("/repositories", () => HttpResponse.json([
      makeRepository({ name: "lfln-bettermodel", changes: 3, ahead: 1, behind: 2, network: "survival" }),
      makeRepository({ name: "golem-config", changes: 0, ahead: 0, behind: 0 }),
      makeRepository({ name: "sonblok-maps", phase: "Cloning", cloneProgress: 64 }),
    ])));
    renderWithQuery(<RepositoriesPage />);
    expect(await screen.findByText("lfln-bettermodel")).toBeInTheDocument();
    expect(screen.getByText("3 changes")).toBeInTheDocument();
    expect(screen.getByText("↓2 ↑1")).toBeInTheDocument();
    expect(screen.getByText("network: survival")).toBeInTheDocument();
    expect(screen.getByText("Clean")).toBeInTheDocument();
    expect(screen.getByText("up to date")).toBeInTheDocument();
    expect(screen.getByText(/Cloning… 64%/)).toBeInTheDocument();
    expect(screen.getByText("GitHub · @arda")).toBeInTheDocument();
  });

  it("filters by the search box", async () => {
    server.use(http.get("/repositories", () => HttpResponse.json([makeRepository({ name: "alpha" }), makeRepository({ name: "beta" })])));
    renderWithQuery(<RepositoriesPage />);
    await screen.findByText("alpha");
    await userEvent.type(screen.getByRole("textbox", { name: "Search repositories" }), "bet");
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
  });

  it("hides Add repository without repositories:create", async () => {
    server.use(http.get("/users/me", () => HttpResponse.json(makeUser({ role: "viewer", permissions: { "*": ["repositories:read"] } }))));
    renderWithQuery(<RepositoriesPage />);
    await screen.findByText("site");
    expect(screen.queryByRole("button", { name: "Add repository" })).not.toBeInTheDocument();
  });

  it("links to Integrations when no GitHub token is connected", async () => {
    server.use(http.get("/integrations/github", () => HttpResponse.json(makeGitHub({ keySet: false, login: "" }))));
    renderWithQuery(<RepositoriesPage />);
    expect(await screen.findByText("Connect GitHub")).toBeInTheDocument();
  });

  it("creates a repository with the name taken from the URL", async () => {
    const posts: unknown[] = [];
    server.use(http.post("/repositories", async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json(makeRepository({ name: "lfln-bettermodel", phase: "Pending" }), { status: 201 });
    }));
    renderWithQuery(<RepositoriesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Add repository" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Repository URL" }), "https://github.com/chunksmith/lfln-bettermodel");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("lfln-bettermodel");
    await waitFor(() => expect(screen.getByRole("button", { name: "Clone repository" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Clone repository" }));
    await waitFor(() => expect(posts).toEqual([{ url: "https://github.com/chunksmith/lfln-bettermodel", name: "lfln-bettermodel", storageSize: "2Gi" }]));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/repositories/$name", params: { name: "lfln-bettermodel" }, search: { ns: "gameplane-games" } }));
  });
});
