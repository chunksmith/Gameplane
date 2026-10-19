import { describe, it, expect } from "vitest";
import { buildCrumbs } from "./Breadcrumbs";

describe("buildCrumbs statistics routes", () => {
  it("labels the overview page as Statistics", () => {
    expect(buildCrumbs("/statistics")).toEqual([
      { label: "gameplane", to: "/" },
      { label: "Statistics", to: "/statistics" },
    ]);
  });

  it("omits the nodes crumb on a node page", () => {
    expect(buildCrumbs("/statistics/nodes/node-a")).toEqual([
      { label: "gameplane", to: "/" },
      { label: "Statistics", to: "/statistics" },
      { label: "node-a", to: "/statistics/nodes/node-a" },
    ]);
  });
});
