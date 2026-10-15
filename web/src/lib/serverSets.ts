import type { GameServer, GameServerSet } from "@/types";
import type { Located } from "@/lib/fleet";

export interface ServerGroup {
  key: string;
  cluster: string;
  namespace: string;
  name: string;
  set?: Located<GameServerSet>;
  servers: Located<GameServer>[];
}

export function serverSetOwner(gs: GameServer): string | undefined {
  return gs.metadata.ownerReferences?.find((ref) => ref.controller && ref.kind === "GameServerSet")?.name;
}

function groupKey(cluster: string, namespace: string, name: string): string {
  return JSON.stringify([cluster, namespace, name]);
}

export function groupServers(servers: Located<GameServer>[], sets: Located<GameServerSet>[]) {
  const groups = new Map<string, ServerGroup>();
  for (const set of sets) {
    const { cluster, namespace } = set.fleetTarget;
    const key = groupKey(cluster, namespace, set.metadata.name);
    groups.set(key, { key, cluster, namespace, name: set.metadata.name, set, servers: [] });
  }
  const standalone: Located<GameServer>[] = [];
  for (const gs of servers) {
    const owner = serverSetOwner(gs);
    if (!owner) {
      standalone.push(gs);
      continue;
    }
    const { cluster, namespace } = gs.fleetTarget;
    const key = groupKey(cluster, namespace, owner);
    const group = groups.get(key) ?? { key, cluster, namespace, name: owner, servers: [] };
    group.servers.push(gs);
    groups.set(key, group);
  }
  return { groups: [...groups.values()].sort((left, right) => left.name.localeCompare(right.name)), standalone };
}
