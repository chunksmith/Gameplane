// Test data factories — produce fully-populated objects matching the
// types in src/types.ts. Each factory accepts a partial override so tests
// can pin only the fields they care about.

import type {
  GameServer,
  GameServerSet,
  GameTemplate,
  Backup,
  BackupSchedule,
  BackupDestination,
  BannedPlayer,
  User,
  AuditEvent,
  ClusterView,
  ClusterInfo,
  ClusterStats,
  CatalogEntry,
  Module,
  ModuleSource,
  PlayerEntry,
  PlayersResp,
  Restore,
  Network,
  NetworkCapture,
  ServerGrant,
  ServerStatistics,
  StatisticsHistory,
  StatisticsLive,
  StatisticsNodeDetail,
  StatisticsNodeSummary,
  StatisticsPoint,
  StatisticsServerSummary,
  GitCommit,
  GitHubIntegration,
  GitStatus,
  Repository,
} from "@/types";
import type { AllConfig } from "@/lib/config";
import type { FileEntry } from "@/lib/endpoints";
import type { FleetItem } from "@/lib/fleet";

// Built-in role permission sets, mirroring the server seed, so makeUser
// produces a permission set consistent with the requested role and
// can()-based UI gating behaves in tests as it would against the API.
const builtinPerms: Record<string, string[]> = {
  admin: ["*"],
  operator: [
    "servers:read", "servers:write", "servers:console",
    "backups:read", "backups:write", "backups:restore",
    "schedules:read", "schedules:write",
    "templates:read", "templates:write",
    "modules:read", "destinations:read", "cluster:read", "roles:read",
  ],
  viewer: [
    "servers:read", "backups:read", "schedules:read", "templates:read",
    "modules:read", "destinations:read", "cluster:read", "roles:read",
  ],
};

// Built-in roles that explicitly do NOT get captures:manage (admin gets it via
// the wildcard "*"; operator/viewer are denied it per FR-005/SC-005).

export function makeUser(over: Partial<User> = {}): User {
  const role = over.role ?? "admin";
  return {
    id: 1,
    username: "admin",
    displayName: "Admin",
    email: "admin@example.com",
    role,
    provider: "local",
    createdAt: "2026-01-01T00:00:00Z",
    permissions: { "*": builtinPerms[role] ?? [] },
    ...over,
  };
}

// Override allows pinning only the nested fields a test cares about (a
// partial metadata/spec/status), unlike a flat Partial<GameServer> which
// would demand a complete spec. The nested objects are deep-merged over
// the defaults below.
type ServerOverride = {
  metadata?: Partial<GameServer["metadata"]>;
  spec?: Partial<GameServer["spec"]>;
  status?: Partial<GameServer["status"]>;
};

export function makeServer(over: ServerOverride = {}): GameServer {
  return {
    metadata: {
      name: "alpha",
      namespace: "gameplane-games",
      creationTimestamp: "2026-04-01T00:00:00Z",
      ...(over.metadata ?? {}),
    },
    spec: {
      templateRef: { name: "minecraft-vanilla" },
      ...(over.spec ?? {}),
    },
    status: {
      phase: "Running",
      agent: { playersOnline: 3, playersMax: 20, lastHeartbeat: "2026-05-07T11:59:30Z" },
      startedAt: "2026-05-07T09:00:00Z",
      ...(over.status ?? {}),
    },
  };
}

export function makeServerSet(over: { metadata?: Partial<GameServerSet["metadata"]>; spec?: Partial<GameServerSet["spec"]>; status?: GameServerSet["status"] } = {}): GameServerSet {
  return {
    metadata: { name: "lobby", namespace: "gameplane-games", uid: "lobby-uid", ...(over.metadata ?? {}) },
    spec: { replicas: 2, template: { templateRef: { name: "minecraft-vanilla" } }, ...(over.spec ?? {}) },
    status: { replicas: 2, readyReplicas: 1, ...(over.status ?? {}) },
  };
}

// Override allows pinning only the nested fields a test cares about (a
// partial spec/metadata/status), unlike a flat Partial<GameTemplate>
// which would demand a complete spec. The nested objects are deep-merged
// over the defaults below.
type TemplateOverride = {
  metadata?: Partial<GameTemplate["metadata"]>;
  spec?: Partial<GameTemplate["spec"]>;
  status?: Partial<NonNullable<GameTemplate["status"]>>;
};

export function makeTemplate(over: TemplateOverride = {}): GameTemplate {
  return {
    metadata: { name: "minecraft-vanilla", ...(over.metadata ?? {}) },
    spec: {
      displayName: "Minecraft (Vanilla)",
      game: "minecraft",
      version: "1.21",
      image: "ghcr.io/gameplanepanel/gameplane/minecraft:1.21",
      consoleMode: "rcon",
      rcon: { protocol: "source" },
      logPath: "/data/logs/latest.log",
      ...(over.spec ?? {}),
    },
    status: { inUseCount: 1, ...(over.status ?? {}) },
  };
}

export function makeBackup(over: Partial<Backup> = {}): Backup {
  return {
    metadata: { name: "alpha-2026-05-07", namespace: "gameplane-games" },
    spec: { serverRef: { name: "alpha" } },
    status: {
      phase: "Succeeded",
      startTime: "2026-05-07T03:00:00Z",
      completionTime: "2026-05-07T03:01:30Z",
      size: "120 MiB",
      snapshotID: "abcd1234ef",
    },
    ...over,
  };
}

export function makeSchedule(over: Partial<BackupSchedule> = {}): BackupSchedule {
  return {
    metadata: { name: "alpha-daily", namespace: "gameplane-games" },
    spec: { serverRef: { name: "alpha" }, schedule: "0 3 * * *", retention: { keepLast: 7 } },
    status: {
      lastSuccessfulTime: "2026-05-07T03:01:30Z",
      nextScheduleTime: "2026-05-08T03:00:00Z",
    },
    ...over,
  };
}

export function makeRestore(over: Partial<Restore> = {}): Restore {
  return {
    metadata: { name: "restore-alpha-1", namespace: "gameplane-games" },
    spec: {
      backupRef: { name: "alpha-2026-05-07" },
      serverRef: { name: "alpha" },
    },
    status: {
      phase: "Succeeded",
      snapshotID: "abcd1234ef",
      startTime: "2026-05-07T04:00:00Z",
      completionTime: "2026-05-07T04:02:00Z",
    },
    ...over,
  };
}

export function makeDestination(over: Partial<BackupDestination> = {}): BackupDestination {
  return {
    name: "default",
    url: "s3:s3.amazonaws.com/gameplane-backups",
    hasPassword: true,
    createdAt: "2026-04-01T00:00:00Z",
    ...over,
  };
}

export function makeAudit(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 1,
    ts: "2026-05-07T12:00:00Z",
    actor: "admin",
    method: "POST",
    path: "/api/v1/servers",
    target: "alpha",
    status: 201,
    ip: "10.0.0.1",
    ...over,
  };
}

export function makeClusterView(over: Partial<ClusterView> = {}): ClusterView {
  return {
    name: "gameplane-prod",
    version: "v1.31.0",
    ready: 3,
    total: 3,
    nodes: [
      {
        name: "node-1",
        roles: ["control-plane", "worker"],
        status: "Ready",
        startedAt: "2026-05-01T00:00:00Z",
        cpu: { used: 2, capacity: 8 },
        memory: { used: 4_000_000_000, capacity: 16_000_000_000 },
        pods: { used: 12, capacity: 110 },
      },
    ],
    ...over,
  };
}

export function makeClusterStats(over: Partial<ClusterStats> = {}): ClusterStats {
  return { nodes: 3, totalStorageBytes: 1_000_000_000_000, usedStorageBytes: 250_000_000_000, diskUsedBytes: 400 * 1024 ** 3, diskTotalBytes: 1000 * 1024 ** 3, ...over };
}

export function makeClusterInfo(over: Partial<ClusterInfo> = {}): ClusterInfo {
  return { clusterName: "homelab-01", version: "v1.31.0", clusterOps: true, updateChannel: "stable", ...over };
}

export function makeCatalog(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    name: "minecraft-vanilla",
    displayName: "Minecraft (Vanilla)",
    summary: "Run a vanilla Minecraft server",
    game: "minecraft",
    sources: [{ name: "upstream", type: "oci" }],
    versions: ["1.21", "1.20", "1.19"],
    latestVersion: "1.21",
    installed: false,
    ...over,
  };
}

export function makeModule(over: Partial<Module> = {}): Module {
  return {
    metadata: { name: "minecraft-vanilla" },
    spec: {
      source: { name: "upstream" },
      name: "minecraft-vanilla",
      version: "1.21",
    },
    status: {
      phase: "Ready",
      appliedVersion: "1.21",
      appliedTemplate: "minecraft-vanilla",
    },
    ...over,
  };
}

export function makeModuleSource(over: Partial<ModuleSource> = {}): ModuleSource {
  return {
    metadata: { name: "upstream" },
    spec: {
      type: "oci",
      oci: {
        url: "ghcr.io/gameplanepanel/gameplane/modules",
        modules: [{ name: "minecraft-vanilla" }],
      },
    },
    status: { lastSync: "2026-05-07T00:00:00Z", modules: [] },
    ...over,
  };
}

export function makePlayers(over: Partial<PlayersResp> = {}): PlayersResp {
  return {
    online: 2,
    max: 20,
    players: ["alice", "bob"],
    asOf: "2026-05-07T12:00:00Z",
    capabilities: { kick: true, ban: true, unban: true, whitelist: true },
    ...over,
  };
}

export function makePlayerEntry(over: Partial<PlayerEntry> = {}): PlayerEntry {
  return {
    steamId: "76561198000000001",
    faction: "Boscali",
    displayName: "Pilot_Vance",
    ...over,
  };
}

export function makeBannedPlayer(over: Partial<BannedPlayer> = {}): BannedPlayer {
  return {
    name: "griefer-1",
    reason: "broke spawn",
    source: "console",
    ...over,
  };
}

export function makeFileEntry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    name: "server.properties",
    path: "/data/server.properties",
    size: 412,
    dir: false,
    mode: "0644",
    modTime: "2026-05-07T12:00:00Z",
    ...over,
  };
}

export function makeConfig(over: Partial<AllConfig> = {}): AllConfig {
  return {
    general: {
      instanceName: "Gameplane (mock)",
      externalURL: "https://gameplane.local",
      defaultNamespace: "gameplane-games",
    },
    auth: { providers: [{ name: "local", kind: "local", enabled: true }] },
    notifications: { sinks: [] },
    telemetry: { sendMetrics: false, extended: false },
    ...over,
  };
}

export function makeCapture(over: Partial<NetworkCapture> = {}): NetworkCapture {
  return {
    captureId: "cap-12345",
    phase: "Completed",
    serverName: "alpha",
    filter: "tcp port 25565",
    maxDurationSeconds: 3600,
    maxSizeBytes: 104857600, // 100 MB
    ttlSecondsAfterFinished: 86400, // 24 hours
    createdAt: "2026-08-23T00:00:00Z",
    startedAt: "2026-08-23T00:00:00Z",
    completedAt: "2026-08-23T01:00:00Z",
    bytesWritten: 1024,
    packetsWritten: 100,
    expiresAt: "2026-08-30T00:00:00Z",
    ...over,
  };
}

const statisticsNow = 1_792_000_000;
const gib = 1024 ** 3;

const statisticsNodes: StatisticsNodeSummary[] = [
  { name: "node-a", ready: true, internalIP: "10.0.0.11", cpuCapacity: 16, memoryCapacity: 64 * gib, pods: 14, cpuUsed: 3.4, memoryUsed: 42 * gib, rx: 9.8e6, tx: 12.6e6, load1: 2.41, diskUsed: 412 * gib, diskCapacity: 1000 * gib },
  { name: "node-b", ready: true, internalIP: "10.0.0.21", cpuCapacity: 32, memoryCapacity: 128 * gib, pods: 21, cpuUsed: 5.1, memoryUsed: 90 * gib, rx: 17.9e6, tx: 22.3e6, load1: 3.3, diskUsed: 655 * gib, diskCapacity: 2000 * gib },
  { name: "node-c", ready: true, internalIP: "10.0.0.22", cpuCapacity: 32, memoryCapacity: 128 * gib, pods: 19, cpuUsed: 2.9, memoryUsed: 81 * gib, rx: 14.2e6, tx: 18.1e6, load1: 2.92, diskUsed: 588 * gib, diskCapacity: 2000 * gib },
];

const statisticsServers: StatisticsServerSummary[] = [
  { name: "alpha", namespace: "gameplane-games", node: "node-a", cpu: 1.2, cpuLimit: 4, memory: 3.8 * gib, memoryLimit: 8 * gib, rx: 9.6e6, tx: 12.4e6, players: 8, maxPlayers: 350 },
  { name: "beta", namespace: "gameplane-games", node: "node-b", cpu: 2.15, cpuLimit: 4, memory: 6.1 * gib, memoryLimit: 8 * gib, rx: 2.2e6, tx: 3.1e6, players: 61, maxPlayers: 500 },
  { name: "gamma", namespace: "gameplane-games", node: "node-c", cpu: 0.94, cpuLimit: 4, memory: 5.7 * gib, memoryLimit: 12 * gib, rx: 1.4e6, tx: 1.9e6, players: 7, maxPlayers: -1 },
];

function statisticsSeries(count: number, stepSeconds: number, base: number, amplitude: number): StatisticsPoint[] {
  return Array.from({ length: count }, (_, index): StatisticsPoint => [
    statisticsNow - (count - 1 - index) * stepSeconds,
    Math.max(0, base + amplitude * Math.sin(index / 3)),
  ]);
}

function statisticsHeatmap(base: number, amplitude: number): Record<string, (number | null)[]> {
  return Object.fromEntries(
    statisticsNodes.map((node, nodeIndex): [string, (number | null)[]] => [
      node.name,
      Array.from({ length: 24 }, (_, index) => Math.max(0, base + amplitude * Math.sin(index / 4 + nodeIndex))),
    ]),
  );
}

export function makeStatisticsLive(over: Partial<StatisticsLive> = {}): StatisticsLive {
  return {
    source: "prometheus",
    warnings: [],
    generatedAt: new Date(statisticsNow * 1000).toISOString(),
    cluster: {
      cpu: { used: 11.4, capacity: 80, series: statisticsSeries(30, 30, 11.4, 1.2) },
      memory: { used: 213 * gib, capacity: 320 * gib, series: statisticsSeries(30, 30, 213 * gib, 2 * gib) },
      network: {
        rx: 41.9e6,
        tx: 53e6,
        rxSeries: statisticsSeries(30, 30, 41.9e6, 6e6),
        txSeries: statisticsSeries(30, 30, 53e6, 6e6),
      },
    },
    nodes: statisticsNodes,
    servers: statisticsServers,
    ...over,
  };
}

export function makeStatisticsHistory(over: Partial<StatisticsHistory> = {}): StatisticsHistory {
  return {
    source: "prometheus",
    warnings: [],
    range: "24h",
    step: 900,
    start: statisticsNow - 86400,
    end: statisticsNow,
    network: {
      rx: statisticsSeries(96, 900, 40e6, 20e6),
      tx: statisticsSeries(96, 900, 50e6, 20e6),
      rxTotal: 3.92e12,
      txTotal: 5.11e12,
      peak: { value: 142e6, at: statisticsNow - 7200 },
      p95: 118e6,
    },
    heatmap: {
      buckets: Array.from({ length: 24 }, (_, index) => statisticsNow - (23 - index) * 3600),
      cpu: statisticsHeatmap(45, 30),
      memory: statisticsHeatmap(70, 10),
      network: statisticsHeatmap(30e6, 20e6),
    },
    nodeCpu: Object.fromEntries(
      statisticsNodes.map((node, nodeIndex): [string, StatisticsPoint[]] => [node.name, statisticsSeries(96, 900, 45 + nodeIndex * 5, 25)]),
    ),
    ...over,
  };
}

export function makeStatisticsNodeDetail(over: Partial<StatisticsNodeDetail> = {}): StatisticsNodeDetail {
  return {
    source: "prometheus",
    warnings: [],
    range: "24h",
    step: 900,
    node: {
      ...statisticsNodes[0],
      osImage: "Ubuntu 24.04.2 LTS",
      kernelVersion: "6.8.0-45-generic",
      kubeletVersion: "v1.31.0",
      bootTime: statisticsNow - 14 * 86400,
    },
    live: {
      load5: 2.1,
      load15: 1.8,
      diskRead: 0.4e6,
      diskWrite: 1.2e6,
      cpuSeries: statisticsSeries(30, 30, 3.4, 0.6),
      memorySeries: statisticsSeries(30, 30, 42 * gib, gib),
      rxSeries: statisticsSeries(30, 30, 9.8e6, 2e6),
      txSeries: statisticsSeries(30, 30, 12.6e6, 2e6),
    },
    cpu: { usage: statisticsSeries(96, 900, 3.4, 1.2), requested: 6.5 },
    memory: { usage: statisticsSeries(96, 900, 42 * gib, 4 * gib), requested: 48 * gib },
    network: { rx: statisticsSeries(96, 900, 9.8e6, 4e6), tx: statisticsSeries(96, 900, 12.6e6, 4e6) },
    interfaces: [
      { name: "eth0", rx: 9.8e6, tx: 12.6e6, rxPackets: 9100, txPackets: 6400, rxTotal: 3.1e11, txTotal: 4e11, errors: 0, drops: 0 },
      { name: "ens19", rx: 2.1e6, tx: 0.8e6, rxPackets: 1500, txPackets: 900, rxTotal: 6.5e10, txTotal: 2.4e10, errors: 0, drops: 12 },
    ],
    filesystems: [{ mountpoint: "/", device: "/dev/sda1", fstype: "ext4", size: 500e9, used: 180e9 }],
    servers: statisticsServers.filter((server) => server.node === "node-a"),
    ...over,
  };
}

export function makeServerStatistics(over: Partial<ServerStatistics> = {}): ServerStatistics {
  return {
    source: "prometheus",
    warnings: [],
    range: "24h",
    step: 900,
    pod: "alpha-0",
    node: "node-a",
    cpu: { usage: statisticsSeries(96, 900, 1.2, 0.8), request: 1, limit: 4 },
    memory: { usage: statisticsSeries(96, 900, 3.8 * gib, 0.3 * gib), request: 2 * gib, limit: 8 * gib },
    network: {
      rx: statisticsSeries(96, 900, 9.6e6, 5e6),
      tx: statisticsSeries(96, 900, 12.4e6, 5e6),
      rxSinceStart: 45.2e9,
      txSinceStart: 14.1e9,
      peak: { value: 31.4e6, at: statisticsNow - 3 * 3600 },
      p95: 22e6,
      rxPackets: 9100,
      txPackets: 6400,
    },
    players: { online: statisticsSeries(96, 900, 40, 35), max: 500 },
    disk: { used: 312e6, total: 2e9, growth: 18e6, read: 0.4e6, write: 1.2e6 },
    health: { restarts: 0, oomKills: 0, throttledPercent: 2.1 },
    ...over,
  };
}

export function makeServerGrant(over: Partial<ServerGrant> = {}): ServerGrant {
  return { userId: 2, cluster: "local", namespace: "gameplane-games", server: "alpha", permissions: ["servers:console"], ...over };
}

export function makeNetwork(over: Partial<Network> = {}): Network {
  return { name: "skyblock", members: [], ...over };
}

export function makeFleetItem(name: string, annotations: Record<string, string> = {}, namespace = "gameplane-games"): FleetItem<GameServer> {
  return {
    target: { cluster: "local", namespace, name, uid: `${name}-uid` },
    resource: makeServer({ metadata: { name, namespace, annotations } }),
    permissions: ["servers:read"],
  };
}

export function makeRepository(over: Partial<Repository> = {}): Repository {
  return {
    name: "site",
    namespace: "gameplane-games",
    uid: "site-uid",
    url: "https://github.com/chunksmith/site",
    branch: "main",
    network: "",
    owner: { id: "1", name: "admin" },
    collaborators: 0,
    phase: "Ready",
    cloneProgress: null,
    error: null,
    head: "a3f9c21",
    ahead: 1,
    behind: 2,
    changes: 2,
    lastFetch: null,
    storage: { size: "2Gi", used: null },
    ...over,
  };
}

export function makeGitStatus(over: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "main",
    head: "a3f9c21",
    upstream: "origin/main",
    ahead: 1,
    behind: 2,
    changes: [
      { path: "build.gradle.kts", state: "M", staged: true, additions: 1, deletions: 1 },
      { path: "config.yml", state: "M", staged: false, additions: 2, deletions: 2 },
      { path: "CHANGELOG.md", state: "U", staged: false, additions: 0, deletions: 0 },
    ],
    ...over,
  };
}

export function makeGitCommit(over: Partial<GitCommit> = {}): GitCommit {
  return { sha: "a3f9c21aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subject: "Bump version", body: "", author: "Kaan", login: "kaan", time: "2026-10-27T10:00:00Z", pushed: true, ...over };
}

export function makeGitHub(over: Partial<GitHubIntegration> = {}): GitHubIntegration {
  return { keySet: true, keyHint: "7c2e", login: "arda", name: "Arda", contents: "write", workflows: false, ...over };
}
