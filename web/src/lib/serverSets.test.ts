import { describe, expect, it } from "vitest";
import { located } from "@/lib/fleet";
import { groupServers } from "@/lib/serverSets";
import { makeServer, makeServerSet } from "@/test/factories";
import type { OwnerReference } from "@/types";

const target = (name: string, cluster = "local", namespace = "gameplane-games") => ({ cluster, namespace, name, uid: `${cluster}/${namespace}/${name}` });

const server = (name: string, ownerReferences?: OwnerReference[], cluster = "local", namespace = "gameplane-games") =>
  located({ target: target(name, cluster, namespace), resource: makeServer({ metadata: { name, namespace, ownerReferences } }), permissions: [] });

const set = (name: string, cluster = "local", namespace = "gameplane-games") =>
  located({ target: target(name, cluster, namespace), resource: makeServerSet({ metadata: { name, namespace } }), permissions: [] });

const ownedBy = (name: string, kind = "GameServerSet", controller = true): OwnerReference[] => [
  { apiVersion: "gameplane.local/v1alpha1", kind, name, uid: `${name}-uid`, controller },
];

describe("groupServers", () => {
  it("nests only controller children of a GameServerSet under that set", () => {
    const children = [server("lobby-0", ownedBy("lobby")), server("lobby-1", ownedBy("lobby"))];
    const strays = [
      server("no-owner"),
      server("non-controller", ownedBy("lobby", "GameServerSet", false)),
      server("other-kind", ownedBy("lobby", "Deployment")),
    ];
    const { groups, standalone } = groupServers([...children, ...strays], [set("lobby")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].servers.map((gs) => gs.metadata.name)).toEqual(["lobby-0", "lobby-1"]);
    expect(standalone.map((gs) => gs.metadata.name)).toEqual(["no-owner", "non-controller", "other-kind"]);
  });

  it("keeps a set with no children as an empty group", () => {
    const { groups } = groupServers([], [set("lobby")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].servers).toEqual([]);
    expect(groups[0].set?.metadata.name).toBe("lobby");
  });

  it("forms a group from children whose set is not listed", () => {
    const { groups, standalone } = groupServers([server("lobby-0", ownedBy("lobby"))], []);
    expect(standalone).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("lobby");
    expect(groups[0].set).toBeUndefined();
    expect(groups[0].servers.map((gs) => gs.metadata.name)).toEqual(["lobby-0"]);
  });

  it("keys groups by cluster and namespace and sorts them by name", () => {
    const { groups } = groupServers(
      [server("lobby-0", ownedBy("lobby"), "remote", "ns-b")],
      [set("lobby", "local", "ns-a"), set("lobby", "remote", "ns-b"), set("arena", "local", "ns-a")],
    );
    expect(groups.map((group) => `${group.cluster}/${group.namespace}/${group.name}`)).toEqual([
      "local/ns-a/arena",
      "local/ns-a/lobby",
      "remote/ns-b/lobby",
    ]);
    expect(groups.map((group) => group.servers.length)).toEqual([0, 0, 1]);
  });
});
