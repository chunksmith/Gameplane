import { http, HttpResponse } from "msw";
import type { FleetIssue, FleetItem, FleetResult } from "@/lib/fleet";
import type { User } from "@/types";
import { makeBackup, makeClusterStats, makeClusterView, makeRestore, makeSchedule, makeServer, makeTemplate } from "./factories";

type Resource = { metadata: { name: string; namespace?: string; uid?: string; annotations?: Record<string, string> } };

// Adapt the existing single-site fixtures (including screenshot datasets and
// per-test overrides) to the new response envelope. Cross-site regressions
// provide explicit /fleet fixtures instead of deriving authorization here.
async function fixture(request: Request, path: string) {
  return fetch(new URL(path, request.url), { headers: { cookie: request.headers.get("cookie") ?? "" } }).catch(() => new Response(null, { status: 503 }));
}

export const fleetHandlers = [
  http.get("/servers/:name/capabilities", async ({ params, request }) => {
    const url = new URL(request.url);
    const cluster = url.searchParams.get("cluster") || "local";
    const namespace = url.searchParams.get("namespace") || "gameplane-games";
    const response = await fixture(request, `/servers/${encodeURIComponent(String(params.name))}${url.search}`);
    if (!response.ok) return new HttpResponse(null, { status: response.status });
    const resource = await response.json() as Resource;
    return HttpResponse.json({
      target: { cluster, namespace, name: String(params.name), uid: resource.metadata.uid },
      capture: { enabled: true, files: true, state: "ready", defaultRetentionSeconds: 86400,
        maxRetentionSeconds: 604800, defaultMaxDurationSeconds: 300, defaultMaxSizeBytes: 5 * 1024 * 1024 * 1024 },
    });
  }),
  http.get("/servers/:name/access", async ({ params, request }) => {
    const url = new URL(request.url);
    const cluster = url.searchParams.get("cluster") || "local";
    const requestedNamespace = url.searchParams.get("namespace") || "gameplane-games";
    const serverURL = new URL(`/servers/${encodeURIComponent(String(params.name))}`, request.url);
    serverURL.searchParams.set("namespace", requestedNamespace);
    if (cluster !== "local") serverURL.searchParams.set("cluster", cluster);
    const resourceResponse = await fixture(request, serverURL.pathname + serverURL.search);
    if (!resourceResponse.ok) return new HttpResponse(null, { status: resourceResponse.status });
    const resource = await resourceResponse.json() as Resource;
    const namespace = resource.metadata.namespace || requestedNamespace;
    const user = await (await fixture(request, "/users/me")).json() as User;
    const permissions = [...(user.permissions?.["*"] ?? []), ...(user.permissions?.[namespace] ?? [])];
    const has = (perm: string) => permissions.includes("*") || permissions.includes(perm);
    const isOwner = resource.metadata.annotations?.["gameplane.local/owner-id"] === String(user.id);
    const isCollaborator = (resource.metadata.annotations?.["gameplane.local/collaborators"] ?? "").split(",").includes(String(user.id));
    return HttpResponse.json({ target: { cluster, namespace, name: String(params.name), uid: resource.metadata.uid }, permissions,
      canWrite: has("servers:write"), canControl: isOwner || isCollaborator || has("servers:write"), canConsole: isOwner || isCollaborator || has("servers:console"), canDelete: isOwner || has("*"), isOwner, isCollaborator });
  }),
  http.get("/fleet/:kind", async ({ params, request, cookies }) => {
    const kind = String(params.kind);
    const url = new URL(request.url);
    const cluster = url.searchParams.get("cluster") || "local";
    const selectedNamespace = url.searchParams.get("namespace");
    const clusterQuery = cluster === "local" ? "" : `cluster=${encodeURIComponent(cluster)}`;
    const scoped = (path: string, namespace?: string) => {
      const query = [clusterQuery, namespace ? `namespace=${encodeURIComponent(namespace)}` : ""].filter(Boolean).join("&");
      return `${path}${query ? `?${query}` : ""}`;
    };
    const userResponse = await fixture(request, "/users/me");
    if (!userResponse.ok) return new HttpResponse(null, { status: userResponse.status });
    const user = await userResponse.json() as User;
    const permissions = (namespace: string) => [...new Set([...(user.permissions?.["*"] ?? []), ...(user.permissions?.[namespace] ?? [])])];
    const has = (perms: string[], perm: string) => perms.includes("*") || perms.includes(perm);
    if (kind === "serversets" && cookies.e2e_multicluster === "1") return HttpResponse.json({ items: [], partial: false, issues: [], totalReturned: 0 });
    if (cookies.e2e_multicluster === "1") {
      const longNodes = cookies.e2e_long_node_names === "1";
      const remoteSite = longNodes ? "remote-location-with-a-long-registered-cluster-identifier" : "remote-demo";
      const sites = ["local", remoteSite].filter((site) => !url.searchParams.has("cluster") || site === cluster);
      const scopes = sites.map((site) => ({ cluster: site, namespace: "gameplane-games" }));
      const items = sites.map((site) => {
        if (kind === "inventory") return { cluster: site, name: site, stats: makeClusterStats(), view: makeClusterView({ name: site, ready: 1, total: 1,
          nodes: [{ name: longNodes ? `${site}-control-plane-with-a-long-unique-node-identifier` : site === "local" ? "gp-demo-central-control-plane" : "gp-demo-remote-control-plane", status: "Ready", cpu: { used: site === "local" ? 1 : 3, capacity: 4 }, memory: { used: 1024, capacity: 4096 } }] }) };
        if (kind === "placements") return { cluster: site, namespace: "gameplane-games", templates: [makeTemplate()] };
        const target = { cluster: site, namespace: "gameplane-games", name: kind === "servers" ? "smoke-same" : `smoke-${kind}`, uid: `${site}-${kind}-uid` };
        const resource = kind === "backups" ? makeBackup({ metadata: { name: target.name, namespace: target.namespace }, spec: { serverRef: { name: "smoke-same" } } })
          : kind === "schedules" ? makeSchedule({ metadata: { name: target.name, namespace: target.namespace } })
          : kind === "restores" ? makeRestore({ metadata: { name: target.name, namespace: target.namespace } })
          : makeServer({ metadata: { name: target.name, namespace: target.namespace, uid: target.uid }, status: { phase: "Running" } });
        return { target, resource, permissions: ["*"], access: { canWrite: true, canControl: true, canConsole: true, canDelete: true, isOwner: false, isCollaborator: false } };
      });
      return HttpResponse.json({ items, scopes, partial: false, issues: [], totalReturned: items.length });
    }
    if (kind === "placements") {
      const namespacesResponse = await fixture(request, scoped("/namespaces"));
      const namespaces = namespacesResponse.ok ? (await namespacesResponse.json() as { namespaces: string[] }).namespaces : [];
      const templatesResponse = await fixture(request, scoped("/templates"));
      const templates = templatesResponse.ok ? (await templatesResponse.json() as { items: unknown[] }).items : [];
      const items = namespaces.filter((namespace) => has(permissions(namespace), "servers:write")).map((namespace) => ({ cluster, namespace, templates }));
      return HttpResponse.json({ items, scopes: items.map(({ cluster: site, namespace }) => ({ cluster: site, namespace })), partial: false, issues: [], totalReturned: items.length });
    }
    if (kind === "inventory") {
      const registry = await fixture(request, "/clusters");
      const registrations = registry.ok ? await registry.json() as { items: { name: string; canViewInventory?: boolean }[] } : { items: [] };
      if (!has(permissions("*"), "cluster:read") || !registrations.items.some((item) => item.name === cluster && item.canViewInventory)) return HttpResponse.json({ items: [], partial: false, issues: [], totalReturned: 0 });
      const [view, stats] = await Promise.all([fixture(request, scoped("/cluster")), fixture(request, scoped("/cluster/stats"))]);
      if (!view.ok || !stats.ok) return HttpResponse.json({ items: [], partial: true, issues: [{ cluster, code: "unavailable", message: "Inventory unavailable." }], totalReturned: 0 });
      return HttpResponse.json({ items: [{ cluster, name: cluster, view: await view.json(), stats: await stats.json() }], partial: false, issues: [], totalReturned: 1 });
    }
    if (!["servers", "backups", "schedules", "restores", "serversets"].includes(kind)) return new HttpResponse(null, { status: 404 });
    const issues: FleetIssue[] = [];
    const items = new Map<string, FleetItem<Resource>>();
    let namespaces = [selectedNamespace || "gameplane-games"];
    if (kind === "servers" && !selectedNamespace) {
      const result = await fixture(request, scoped("/namespaces"));
      if (result.ok) namespaces = (await result.json() as { namespaces: string[] }).namespaces;
      else issues.push({ cluster, code: "unavailable", message: "Namespace discovery unavailable." });
    }
    const add = (resource: Resource, namespace: string, owner = false) => {
      const ns = resource.metadata.namespace || namespace;
      const perms = permissions(ns);
      const target = { cluster, namespace: ns, name: resource.metadata.name, uid: resource.metadata.uid || `${cluster}/${ns}/${resource.metadata.name}` };
      const key = `${cluster}/${ns}/${target.name}`;
      if (items.has(key)) return;
      items.set(key, { target, resource, permissions: perms,
        ...(kind === "servers" ? { access: { canWrite: has(perms, "servers:write"), canControl: owner || has(perms, "servers:write"), canConsole: owner || has(perms, "servers:console"), canDelete: owner || has(perms, "servers:write"), isOwner: owner, isCollaborator: false } } : {}),
      });
    };
    for (const namespace of namespaces) {
      const response = await fixture(request, scoped(`/${kind}`, namespace));
      if (!response.ok) { issues.push({ cluster, namespace, code: "unavailable", message: `${kind} unavailable.` }); continue; }
      const list = await response.json() as { items: Resource[] };
      for (const resource of list.items) add(resource, namespace);
    }
    // The namespace-only/ownership cases explicitly override this mock list;
    // ordinary fixtures stay stable while dedicated fleet tests cover overlap.
    if (kind === "servers") {
      const response = await fixture(request, scoped("/users/me/servers"));
      if (response.ok) for (const resource of (await response.json() as { items: Resource[] }).items) add(resource, resource.metadata.namespace || "gameplane-games", true);
      else issues.push({ cluster, code: "unavailable", message: "Owned servers unavailable." });
    }
    const result: FleetResult<FleetItem<Resource>> = { items: [...items.values()], partial: issues.length > 0, issues, totalReturned: items.size };
    return HttpResponse.json(result);
  }),
];
