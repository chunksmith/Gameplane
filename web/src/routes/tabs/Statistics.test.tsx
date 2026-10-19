import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeServerStatistics } from "@/test/factories";
import { STATISTICS_SETUP_URL } from "@/lib/links";
import { StatisticsTab } from "./Statistics";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params?: Record<string, string>; children: ReactNode } & Record<string, unknown>) => (
    <a href={to.replace("$name", params?.name ?? "")} {...rest}>
      {children}
    </a>
  ),
}));

describe("StatisticsTab", () => {
  it("renders the CPU, memory, network, players and storage cards", async () => {
    renderWithQuery(<StatisticsTab name="alpha" />);
    expect(await screen.findByRole("img", { name: "CPU usage" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Memory usage" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Network throughput" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Players online" })).toBeInTheDocument();
    expect(screen.getByText("Storage & health")).toBeInTheDocument();
    expect(screen.getByText("0.4 / 1.2 MB/s")).toBeInTheDocument();
    expect(screen.getByText("2.1%")).toBeInTheDocument();
  });

  it("says no limit is set when the CPU has no limit", async () => {
    const base = makeServerStatistics();
    server.use(
      http.get("/servers/:name/statistics", () => HttpResponse.json({ ...base, cpu: { ...base.cpu, limit: null } })),
    );
    renderWithQuery(<StatisticsTab name="alpha" />);
    expect(await screen.findByText("Cores · last 24h · no limit set")).toBeInTheDocument();
  });

  it("shows the players empty state when the agent metric is not scraped", async () => {
    server.use(
      http.get("/servers/:name/statistics", () => HttpResponse.json(makeServerStatistics({ players: null }))),
    );
    renderWithQuery(<StatisticsTab name="alpha" />);
    expect(
      await screen.findByText("Player history needs Prometheus to scrape the agent (serviceMonitors.enabled)."),
    ).toBeInTheDocument();
  });

  it("shows the setup state when Prometheus is not configured", async () => {
    server.use(
      http.get("/servers/:name/statistics", () => HttpResponse.json(makeServerStatistics({ source: "none" }))),
    );
    renderWithQuery(<StatisticsTab name="alpha" />);
    expect(await screen.findByText("Prometheus is not configured")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Setup guide" })).toHaveAttribute("href", STATISTICS_SETUP_URL);
    expect(screen.queryByRole("img", { name: "CPU usage" })).not.toBeInTheDocument();
  });

  it("names an unreachable Prometheus separately", async () => {
    server.use(
      http.get("/servers/:name/statistics", () =>
        HttpResponse.json(makeServerStatistics({ source: "none", warnings: ["prometheus_unreachable"] })),
      ),
    );
    renderWithQuery(<StatisticsTab name="alpha" />);
    expect(await screen.findByText("Prometheus is unreachable")).toBeInTheDocument();
  });

  it("refetches the history with the picked range", async () => {
    const ranges: (string | null)[] = [];
    server.use(
      http.get("/servers/:name/statistics", ({ request }) => {
        ranges.push(new URL(request.url).searchParams.get("range"));
        return HttpResponse.json(makeServerStatistics());
      }),
    );
    renderWithQuery(<StatisticsTab name="alpha" />);
    await screen.findByRole("img", { name: "CPU usage" });
    await userEvent.click(screen.getByRole("radio", { name: "1h" }));
    await waitFor(() => expect(ranges).toContain("1h"));
    expect(screen.getByRole("radio", { name: "1h" })).toHaveAttribute("aria-checked", "true");
  });

  it("links the storage node to its node page", async () => {
    renderWithQuery(<StatisticsTab name="alpha" />);
    expect(await screen.findByRole("link", { name: "node-a" })).toHaveAttribute("href", "/statistics/nodes/node-a");
  });
});
