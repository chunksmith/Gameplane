import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Statistics } from "./endpoints";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function requestedURL(): unknown {
  return fetchMock.mock.calls.at(-1)?.[0];
}

describe("Statistics endpoints", () => {
  it("reads live statistics", async () => {
    await Statistics.live();
    expect(requestedURL()).toBe("/statistics/live");
  });

  it("reads history for a range", async () => {
    await Statistics.history("7d");
    expect(requestedURL()).toBe("/statistics/history?range=7d");
  });

  it("reads a node by name", async () => {
    await Statistics.node("node-a", "1h");
    expect(requestedURL()).toBe("/statistics/nodes/node-a?range=1h");
  });

  it("encodes the node name", async () => {
    await Statistics.node("a b", "15m");
    expect(requestedURL()).toBe("/statistics/nodes/a%20b?range=15m");
  });

  it("reads a server statistics tab in its namespace", async () => {
    await Statistics.server("alpha", "24h", "gameplane-games");
    expect(requestedURL()).toBe("/servers/alpha/statistics?range=24h&namespace=gameplane-games");
  });

  it("reads a server statistics tab without a namespace", async () => {
    await Statistics.server("alpha", "30d");
    expect(requestedURL()).toBe("/servers/alpha/statistics?range=30d");
  });
});
