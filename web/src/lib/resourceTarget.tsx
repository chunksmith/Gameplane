import { createContext, useContext, useMemo, type ReactNode } from "react";
import * as endpoints from "./endpoints";
import { type ResourceScope } from "./api";
import { targetSearch } from "./fleet";
import type { ResourceClient } from "./endpoints";

export type { ResourceScope } from "./api";

export interface ResourceTarget extends ResourceScope {
  readonly name: string;
  readonly uid?: string;
}

export interface ServerAccess {
  canWrite: boolean;
  canControl: boolean;
  canConsole: boolean;
  canDelete: boolean;
  isOwner: boolean;
  isCollaborator: boolean;
  permissions?: string[];
}

export interface ServerAccessResponse extends ServerAccess {
  target: ResourceTarget;
}

export function serverLink(target: ResourceTarget) {
  return {
    to: "/servers/$name" as const,
    params: { name: target.name },
    search: targetSearch(target),
  };
}

export function resourceKey(target: ResourceTarget, ...parts: readonly unknown[]) {
  const kind = parts[0];
  if (kind === "server") return ["resource", target.cluster, target.namespace ?? "", target.name, "", "server"] as const;
  if (["servers", "backups", "schedules", "restores", "backup-destinations"].includes(String(kind))) {
    return ["resource", target.cluster, target.namespace ?? "", "collection", kind] as const;
  }
  return ["resource", target.cluster, target.namespace ?? "", target.name, target.uid ?? "", ...parts] as const;
}

interface ResourceContextValue {
  target: ResourceTarget;
  access?: ServerAccess;
  client: ResourceClient;
}

const ResourceContext = createContext<ResourceContextValue | null>(null);

export function ResourceTargetProvider({ target, access, children }: {
  target: ResourceTarget;
  access?: ServerAccess;
  children: ReactNode;
}) {
  const { cluster, namespace, name, uid } = target;
  const value = useMemo<ResourceContextValue>(() => {
    const captured = Object.freeze({ cluster, namespace, name, uid });
    return { target: captured, access, client: endpoints.createResourceClient(captured) };
  }, [cluster, namespace, name, uid, access]);
  return <ResourceContext.Provider value={value}>{children}</ResourceContext.Provider>;
}

export function useResourceTarget(fallback: { name: string; namespace?: string }, explicit?: ResourceTarget): ResourceTarget {
  const context = useContext(ResourceContext);
  const cluster = explicit?.cluster ?? context?.target.cluster ?? "local";
  const namespace = explicit?.namespace ?? fallback.namespace ?? context?.target.namespace;
  const name = explicit?.name ?? fallback.name;
  const uid = explicit?.uid ?? (name === context?.target.name ? context.target.uid : undefined);
  return useMemo(() => Object.freeze({ cluster, namespace, name, uid }), [cluster, namespace, name, uid]);
}

export function useResourceClient(explicit?: ResourceScope): ResourceClient {
  const context = useContext(ResourceContext);
  const cluster = explicit?.cluster;
  const namespace = explicit?.namespace;
  const client = context?.client;
  return useMemo(
    () => cluster !== undefined ? endpoints.createResourceClient({ cluster, namespace }) : client ?? endpoints.createResourceClient({ cluster: "local" }),
    [cluster, namespace, client],
  );
}

export function useResourceAccess(explicit?: ServerAccess): ServerAccess | undefined {
  const context = useContext(ResourceContext);
  return explicit ?? context?.access;
}

export function useResourcePermissions(explicit?: readonly string[]): readonly string[] {
  const context = useContext(ResourceContext);
  return explicit ?? context?.access?.permissions ?? [];
}
export function resourceCan(permissions: readonly string[], permission: string): boolean {
  return permissions.includes("*") || permissions.includes(permission);
}
