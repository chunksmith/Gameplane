import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeStatisticsHistory, makeStatisticsLive } from "@/test/factories";
import { StatisticsPage } from "./Statistics";

const navigate = vi.fn();
let search: Record<string, unknown> = {};

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useSearch: () => search,
  Link: ({ to, params, search: linkSearch, className, children }: { to: string; params?: Record<string, string>; search?: Record<string, string>; className?: string; children: ReactNode }) => {
    const path = params ? to.replace("$name", params.name) : to;
    const query = linkSearch ? `?${new URLSearchParams(linkSearch).toString()}` : "";
    return <a href={`${path}${query}`} className={className}>{children}</a>;
  },
}));

const metricsServerCluster = {
  cpu: { used: 11.4, capacity: 80, series: [] },
  memory: { used: 213e9, capacity: 320e9, series: [] },
  network: null,
};

describe("StatisticsPage", () => {
  beforeEach(() => {
    navigate.mockReset();
    search = {};
  });

  it("renders the live cards, network chart and nodes table from Prometheus data", async () => {
    renderWithQuery(<StatisticsPage />);
    expect(await screen.findByText("Live usage")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Network throughput" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Bandwidth by node" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Utilization heatmap" })).toBeInTheDocument();
    expect(screen.getByText("Nodes")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^node-a/ })).toHaveAttribute("href", "/statistics/nodes/node-a?range=24h");
    expect(screen.getByText("Top game servers")).toBeInTheDocument();
  });

  it("shows the Prometheus callout and hides history sections without Prometheus", async () => {
    let historyRequests = 0;
    server.use(
      http.get("/statistics/live", () => HttpResponse.json(makeStatisticsLive({ source: "metrics-server", cluster: metricsServerCluster, servers: [] }))),
      http.get("/statistics/history", () => {
        historyRequests += 1;
        return HttpResponse.json(makeStatisticsHistory());
      }),
    );
    renderWithQuery(<StatisticsPage />);
    expect(await screen.findByText("Connect Prometheus to unlock history, bandwidth and heatmaps")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Network throughput" })).not.toBeInTheDocument();
    expect(screen.queryByText("Utilization heatmap")).not.toBeInTheDocument();
    expect(screen.getAllByText("No bandwidth data")).toHaveLength(2);
    expect(screen.getAllByText("Needs Prometheus")).toHaveLength(2);
    expect(screen.getByText("Nodes")).toBeInTheDocument();
    expect(historyRequests).toBe(0);
  });

  it("shows the unreachable warning when Prometheus does not answer", async () => {
    server.use(
      http.get("/statistics/live", () =>
        HttpResponse.json(makeStatisticsLive({ source: "metrics-server", warnings: ["prometheus_unreachable"], cluster: metricsServerCluster })),
      ),
    );
    renderWithQuery(<StatisticsPage />);
    expect(await screen.findByText("Prometheus is unreachable")).toBeInTheDocument();
    expect(screen.queryByText("Connect Prometheus to unlock history, bandwidth and heatmaps")).not.toBeInTheDocument();
  });

  it("refetches history with the newly selected range", async () => {
    const requestedRanges: (string | null)[] = [];
    server.use(
      http.get("/statistics/history", ({ request }) => {
        const range = new URL(request.url).searchParams.get("range");
        requestedRanges.push(range);
        return HttpResponse.json(makeStatisticsHistory({ range: range === "7d" ? "7d" : "24h" }));
      }),
    );
    navigate.mockImplementation((options: { search?: Record<string, unknown> }) => {
      search = options.search ?? {};
      return Promise.resolve();
    });
    const { client, rerender } = renderWithQuery(<StatisticsPage />);
    await waitFor(() => expect(requestedRanges).toContain("24h"));
    await userEvent.click(await screen.findByRole("radio", { name: "7d" }));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/statistics", search: { range: "7d" } }));
    rerender(
      <QueryClientProvider client={client}>
        <StatisticsPage />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(requestedRanges).toContain("7d"));
  });

  it("navigates to a node's page from the node picker", async () => {
    renderWithQuery(<StatisticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Node$/ }));
    await userEvent.click(await screen.findByRole("option", { name: "node-b" }));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/statistics/nodes/$name", params: { name: "node-b" } }));
  });

  it("sorts the top game servers by the selected metric", async () => {
    renderWithQuery(<StatisticsPage />);
    const sortGroup = await screen.findByRole("radiogroup", { name: "Sort game servers by" });
    await userEvent.click(within(sortGroup).getByRole("radio", { name: "Network" }));
    const serverLinks = screen.getAllByRole("link", { name: /local \/ gameplane-games/ });
    expect(serverLinks[0]).toHaveAttribute("href", "/servers/alpha?ns=gameplane-games");
  });
});
