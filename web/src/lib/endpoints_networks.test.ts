import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Networks, Servers } from "./endpoints";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function last(): { url: string; method?: string; body?: string } {
  const call = fetchMock.mock.calls.at(-1);
  expect(call).toBeDefined();
  const init = (call![1] ?? {}) as { method?: string; body?: string };
  return { url: call![0] as string, method: init.method, body: init.body };
}

describe("Networks endpoints", () => {
  it("lists networks", async () => {
    await Networks.list();
    expect(last().url).toBe("/networks");
  });

  it("creates a network", async () => {
    await Networks.create("smp");
    expect(last()).toMatchObject({ url: "/networks", method: "POST" });
    expect(JSON.parse(last().body ?? "{}")).toEqual({ name: "smp" });
  });

  it("deletes a network", async () => {
    await Networks.remove("sky block");
    expect(last()).toMatchObject({ url: "/networks/sky%20block", method: "DELETE" });
  });

  it("adds and removes members", async () => {
    await Networks.addMember("smp", 7, ["servers:console"]);
    expect(last()).toMatchObject({ url: "/networks/smp/members/7", method: "PUT" });
    expect(JSON.parse(last().body ?? "{}")).toEqual({ permissions: ["servers:console"] });
    await Networks.removeMember("smp", 7);
    expect(last()).toMatchObject({ url: "/networks/smp/members/7", method: "DELETE" });
  });

  it("assigns a server to a network", async () => {
    await Servers.setNetwork("s1", "games", "smp");
    expect(last()).toMatchObject({ url: "/servers/s1:network?namespace=games", method: "PUT" });
    expect(JSON.parse(last().body ?? "{}")).toEqual({ network: "smp" });
  });
});
