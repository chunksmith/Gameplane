import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>{children}</a>
  ),
  Outlet: () => <div data-testid="outlet">outlet</div>,
  useLocation: () => ({ pathname: "/" }),
  useMatches: () => [],
  useNavigate: () => vi.fn(),
}));

import { AppLayout } from "./AppLayout";

async function sidebarNav() {
  return within(await screen.findByRole("navigation", { name: "Primary" }));
}

describe("AppLayout assistant link", () => {
  it("hides the Assistant link while the assistant is off", async () => {
    renderWithQuery(<AppLayout />);
    const nav = await sidebarNav();
    await waitFor(() => expect(nav.getByRole("link", { name: /Dashboard/i })).toBeInTheDocument());
    expect(nav.queryByRole("link", { name: /Assistant/i })).not.toBeInTheDocument();
  });

  it("shows the Assistant link under General once enabled", async () => {
    server.use(http.get("/ai/status", () => HttpResponse.json({ enabled: true, configured: true, defaultModel: "claude-opus-5-5", defaultEffort: "medium" })));
    renderWithQuery(<AppLayout />);
    const nav = await sidebarNav();
    expect(await nav.findByRole("link", { name: /Assistant/i })).toHaveAttribute("href", "/assistant");
  });
});
