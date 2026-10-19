import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen } from "@testing-library/react";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeStatisticsNodeDetail } from "@/test/factories";
import { StatisticsNodePage } from "./StatisticsNode";

const navigate = vi.fn();

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useParams: () => ({ name: "node-a" }),
  useSearch: () => ({}),
  Link: ({ to, params, search: linkSearch, className, children }: { to: string; params?: Record<string, string>; search?: Record<string, string>; className?: string; children: ReactNode }) => {
    const path = params ? to.replace("$name", params.name) : to;
    const query = linkSearch ? `?${new URLSearchParams(linkSearch).toString()}` : "";
    return <a href={`${path}${query}`} className={className}>{children}</a>;
  },
}));

describe("StatisticsNodePage", () => {
  it("renders the node header, charts, interfaces, filesystems and game servers", async () => {
    renderWithQuery(<StatisticsNodePage />);
    expect(await screen.findByText(/kernel 6\.8\.0-45-generic/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "CPU usage" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Memory usage" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Network throughput" })).toBeInTheDocument();
    expect(screen.getByText("eth0")).toBeInTheDocument();
    expect(screen.getByText(/\/dev\/sda1/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /alpha/ })).toHaveAttribute("href", "/servers/alpha?ns=gameplane-games");
  });

  it("shows the not-found card for an unknown node", async () => {
    server.use(http.get("/statistics/nodes/:name", () => new HttpResponse("not found\n", { status: 404 })));
    renderWithQuery(<StatisticsNodePage />);
    expect(await screen.findByText("This node was not found.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to statistics" })).toHaveAttribute("href", "/statistics");
  });

  it("shows the callout and hides history sections without Prometheus", async () => {
    const base = makeStatisticsNodeDetail();
    server.use(
      http.get("/statistics/nodes/:name", () =>
        HttpResponse.json({
          ...base,
          source: "metrics-server",
          node: { ...base.node, rx: null, tx: null },
          live: { ...base.live, cpuSeries: [], memorySeries: [], rxSeries: [], txSeries: [] },
          cpu: { usage: [], requested: null },
          memory: { usage: [], requested: null },
          network: { rx: [], tx: [] },
          interfaces: [],
          filesystems: [],
          servers: [],
        }),
      ),
    );
    renderWithQuery(<StatisticsNodePage />);
    expect(await screen.findByText("Connect Prometheus to unlock history, bandwidth and heatmaps")).toBeInTheDocument();
    expect(screen.getAllByText("Needs Prometheus")).toHaveLength(2);
    expect(screen.queryByRole("img", { name: "CPU usage" })).not.toBeInTheDocument();
    expect(screen.queryByText("Filesystems")).not.toBeInTheDocument();
  });
});
