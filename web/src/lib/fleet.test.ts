import { describe, expect, it } from "vitest";
import { inventoryTotals, sumNodeUsage, targetHref, targetKey, targetSearch } from "./fleet";
import { makeClusterStats, makeClusterView } from "@/test/factories";

describe("fleet identities and resource totals", () => {
  it("keeps cluster, namespace and replacement UID distinct", () => {
    const target = { cluster: "west", namespace: "games", name: "same", uid: "old" };
    expect(new Set([target, { ...target, cluster: "east" }, { ...target, namespace: "other" }, { ...target, uid: "new" }].map(targetKey)).size).toBe(4);
    expect(targetSearch(target)).toEqual({ cluster: "west", ns: "games" });
    expect(targetHref(target)).toBe("/servers/same?cluster=west&ns=games");
    expect(targetSearch({ cluster: "local", namespace: "gameplane-games" })).toEqual({});
    expect(targetHref({ ...target, cluster: "local", namespace: "gameplane-games" })).toBe("/servers/same");
  });

  it("weights measured CPU usage by capacity rather than averaging percentages", () => {
    const result = sumNodeUsage([
      { name: "small", status: "Ready", cpu: { used: 1, capacity: 2 } },
      { name: "large", status: "Ready", cpu: { used: 6, capacity: 8 } },
    ], "cpu");
    expect(result).toEqual({ known: true, used: 7, capacity: 10, pct: 70 });
  });

  it("does not count a missing reading as idle capacity", () => {
    expect(sumNodeUsage([
      { name: "measured", status: "Ready", cpu: { used: 2, capacity: 4 } },
      { name: "unmeasured", status: "Ready", cpu: { capacity: 96 } },
    ], "cpu").known).toBe(false);
    expect(sumNodeUsage([], "memory").known).toBe(false);
    expect(sumNodeUsage([{ name: "zero", status: "Ready", cpu: { used: 0, capacity: 0 } }], "cpu").known).toBe(false);
  });

  it("keeps measured zero and storage overcommit meaningful", () => {
    expect(sumNodeUsage([{ name: "idle", status: "Ready", cpu: { used: 0, capacity: 4 } }], "cpu")).toMatchObject({ known: true, pct: 0 });
    const totals = inventoryTotals([
      { cluster: "a", name: "A", view: makeClusterView({ nodes: [], ready: 0, total: 0 }), stats: makeClusterStats({ usedStorageBytes: 80, totalStorageBytes: 50 }) },
      { cluster: "b", name: "B", view: makeClusterView({ nodes: [], ready: 0, total: 0 }), stats: makeClusterStats({ usedStorageBytes: 70, totalStorageBytes: 50 }) },
    ]);
    expect(totals.usedStorageBytes).toBe(150);
    expect(totals.totalStorageBytes).toBe(100);
    expect(inventoryTotals([]).usedStorageBytes).toBeUndefined();
  });
});
