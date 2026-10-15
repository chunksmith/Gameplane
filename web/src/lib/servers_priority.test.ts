import { describe, it, expect } from "vitest";
import { byPriority, reorderPriorities, serverPriority } from "@/lib/servers";
import { PRIORITY_ANNOTATION } from "@/lib/annotations";
import { makeServer } from "@/test/factories";

const server = (name: string, priority?: number, creationTimestamp = "2026-04-01T00:00:00Z") =>
  makeServer({ metadata: { name, creationTimestamp, annotations: priority === undefined ? undefined : { [PRIORITY_ANNOTATION]: String(priority) } } });

const changes = (result: ReturnType<typeof reorderPriorities>) => result.map(([gs, priority]) => [gs.metadata.name, priority]);

describe("serverPriority", () => {
  it("reads the annotation and falls back to creation time", () => {
    expect(serverPriority(server("a", -5))).toBe(-5);
    expect(serverPriority(server("a"))).toBe(Date.parse("2026-04-01T00:00:00Z"));
    expect(serverPriority(makeServer({ metadata: { name: "a", creationTimestamp: undefined, annotations: { [PRIORITY_ANNOTATION]: "1.5" } } }))).toBe(0);
  });

  it("sorts by priority then name", () => {
    const sorted = [server("c", 2), server("b", 1), server("a", 2)].sort(byPriority);
    expect(sorted.map((gs) => gs.metadata.name)).toEqual(["b", "a", "c"]);
  });
});

describe("reorderPriorities", () => {
  const [a, b, c] = [server("a", 0), server("b", 1024), server("c", 2048)];
  const list = [a, b, c];

  it("writes one midpoint when there is a gap", () => {
    expect(changes(reorderPriorities(list, c, b, false))).toEqual([["c", 512]]);
  });

  it("moves to the top and bottom", () => {
    expect(changes(reorderPriorities(list, c, a, false))).toEqual([["c", -1024]]);
    expect(changes(reorderPriorities(list, a, c, true))).toEqual([["a", 3072]]);
  });

  it("skips drops that keep the order", () => {
    expect(reorderPriorities(list, b, b, true)).toEqual([]);
    expect(reorderPriorities(list, b, a, true)).toEqual([]);
  });

  it("bumps following servers when priorities tie", () => {
    const tied = [server("x", 5), server("y", 5), server("z", 5)];
    expect(changes(reorderPriorities(tied, tied[2], tied[1], false))).toEqual([["z", 1029], ["y", 2053]]);
  });

  it("gives creation-time servers explicit priorities on first move", () => {
    const fresh = [server("old", undefined, "2026-04-01T00:00:00Z"), server("new", undefined, "2026-04-01T00:00:10Z")];
    expect(changes(reorderPriorities(fresh, fresh[1], fresh[0], false))).toEqual([["new", Date.parse("2026-04-01T00:00:00Z") - 1024]]);
  });
});
