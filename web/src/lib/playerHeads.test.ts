import { afterEach, describe, expect, it, vi } from "vitest";
import { playerHeadUrl } from "./playerHeads";

function fakeCaches(store: Map<string, Response>) {
  return {
    open: () =>
      Promise.resolve({
        match: (key: string) => Promise.resolve(store.get(key)),
        put: (key: string, res: Response) => {
          store.set(key, res);
          return Promise.resolve();
        },
      }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playerHeadUrl", () => {
  it("returns the direct URL when Cache Storage is unavailable", async () => {
    vi.stubGlobal("caches", undefined);
    expect(await playerHeadUrl("Steve")).toBe("https://mc-heads.net/avatar/steve/64");
  });

  it("fetches a head once, stores it and reuses it", async () => {
    const store = new Map<string, Response>();
    const fetchMock = vi.fn(() => Promise.resolve(new Response("png", { headers: { "Content-Type": "image/png" } })));
    vi.stubGlobal("caches", fakeCaches(store));
    vi.stubGlobal("fetch", fetchMock);
    URL.createObjectURL = vi.fn(() => "blob:head");
    expect(await playerHeadUrl("Alex")).toBe("blob:head");
    expect(await playerHeadUrl("ALEX")).toBe("blob:head");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.has("https://mc-heads.net/avatar/alex/64")).toBe(true);
  });

  it("serves a fresh Cache Storage hit without fetching", async () => {
    const store = new Map([
      ["https://mc-heads.net/avatar/herobrine/64", new Response("png", { headers: { "x-cached-at": String(Date.now()) } })],
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("caches", fakeCaches(store));
    vi.stubGlobal("fetch", fetchMock);
    URL.createObjectURL = vi.fn(() => "blob:cached");
    expect(await playerHeadUrl("Herobrine")).toBe("blob:cached");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries after a failed fetch", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("", { status: 404 })));
    vi.stubGlobal("caches", fakeCaches(new Map()));
    vi.stubGlobal("fetch", fetchMock);
    await expect(playerHeadUrl("Ghost")).rejects.toThrow();
    await expect(playerHeadUrl("Ghost")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
