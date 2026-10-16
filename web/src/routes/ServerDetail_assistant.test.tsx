import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeServer } from "@/test/factories";
import type { AssistantScope } from "@/lib/assistant";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>{children}</a>
  ),
  useParams: () => ({ name: "alpha" }),
  useSearch: () => ({ cluster: "eu", ns: "team-b" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("./tabs/Overview", () => ({ OverviewTab: () => <div>overview-tab</div> }));
vi.mock("@/components/assistant/AssistantPanel", () => ({
  AssistantPanel: ({ scope }: { scope?: AssistantScope }) => <div>assistant-panel {JSON.stringify(scope)}</div>,
}));

import { ServerDetailPage } from "./ServerDetail";

function mockServer(enabled: boolean) {
  server.use(
    http.get("/ai/status", () => HttpResponse.json({ enabled, configured: true, defaultModel: "claude-opus-5-5", defaultEffort: "medium" })),
    http.get("/servers/alpha", () => HttpResponse.json(makeServer({ metadata: { namespace: "team-b" }, status: { phase: "Running" } }))),
    http.get("/servers/:name/access", () => HttpResponse.json({
      target: { cluster: "eu", namespace: "team-b", name: "alpha" },
      canWrite: true, canControl: true, canConsole: true, canDelete: true, isOwner: false, isCollaborator: false,
      permissions: ["servers:read", "servers:write"],
    })),
  );
}

describe("ServerDetailPage assistant tab", () => {
  it("hides the Assistant tab while the assistant is off", async () => {
    mockServer(false);
    renderWithQuery(<ServerDetailPage />);
    expect(await screen.findByText("overview-tab")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Assistant" })).not.toBeInTheDocument());
  });

  it("opens the assistant scoped to this server", async () => {
    mockServer(true);
    renderWithQuery(<ServerDetailPage />);
    await userEvent.click(await screen.findByRole("tab", { name: "Assistant" }));
    expect(await screen.findByText(`assistant-panel ${JSON.stringify({ server: "alpha", namespace: "team-b", cluster: "eu" })}`)).toBeInTheDocument();
  });
});
