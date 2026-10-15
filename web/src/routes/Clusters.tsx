import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, CardContent } from "@heroui/react";
import { Clock, Cpu, Network, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorCard } from "@/components/ui/ErrorCard";
import { LoadingCard } from "@/components/ui/LoadingCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { Clusters } from "@/lib/endpoints";
import { getCurrentCluster, setCurrentCluster, useCurrentCluster } from "@/lib/cluster";
import { useClusterSelection } from "@/lib/useClusterSelection";
import { useMe, can } from "@/lib/auth";
import { cn, formatRelative } from "@/lib/utils";
import { RegisterClusterDialog } from "@/components/RegisterClusterDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export function ClustersPage() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (name: string) => Clusters.remove(name),
    onSuccess: async (_data, name) => {
      if (getCurrentCluster() === name) setCurrentCluster("");
      setRemoveTarget(null);
      await client.invalidateQueries({ queryKey: ["clusters"] });
      await client.invalidateQueries({ queryKey: ["fleet"] });
    },
  });
  const currentCluster = useCurrentCluster();
  const selectCluster = useClusterSelection();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["clusters"],
    queryFn: () => Clusters.list(),
    refetchInterval: 30_000,
  });
  const clusters = data?.items ?? [];
  const openCluster = async (id: string, destination: "/servers" | "/cluster") => {
    if (destination === "/servers") { await navigate({ to: "/servers", search: { cluster: id } }); return; }
    await selectCluster(id);
    await navigate({ to: destination });
  };

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <PageHeader title="Clusters" description="Administration of registered locations, connectivity and node inventory."
        actions={can(me, "cluster:manage") && <Button onPress={() => setRegisterOpen(true)}><Plus className="h-4 w-4" /> Register cluster</Button>} />
      {registerOpen && <RegisterClusterDialog open onOpenChange={setRegisterOpen} />}
      <ConfirmDialog open={!!removeTarget} onOpenChange={(open) => {
        if (!open && !remove.isPending) { setRemoveTarget(null); remove.reset(); }
      }} title={`Remove ${removeTarget ?? ""}?`}
        description={<div className="space-y-3">
          <p>Removes this panel&apos;s connection to the cluster. Running workloads remain on the cluster.</p>
          {remove.error && <p role="alert" className="text-danger">Couldn&apos;t remove the cluster registration. Try again.</p>}
        </div>}
        confirmLabel="Remove cluster" destructive busy={remove.isPending} onConfirm={() => removeTarget && remove.mutate(removeTarget)} />
      {!isLoading && !error && !can(me, "cluster:manage") && !clusters.some((item) => item.canViewInventory) ? (
        <ErrorCard message="Cluster administration requires inventory or cluster-management access." />
      ) : isLoading ? (
        <LoadingCard message="Loading clusters…" />
      ) : error ? (
        <ErrorCard message="Couldn't load registered clusters. Try again." onRetry={() => void refetch()} />
      ) : clusters.length === 0 ? (
        <Card className="border border-border"><EmptyState icon={<Network />} title="No clusters available" hint={can(me, "cluster:manage") ? "Register a workload cluster to deploy and manage game servers. This panel can run without a local cluster." : "Ask your administrator for access to a registered cluster."} /></Card>
      ) : (
        <>
          <p className="text-sm text-muted">{clusters.length} {clusters.length === 1 ? "cluster" : "clusters"} available · Status reports Kubernetes API connectivity, not game or gateway health.</p>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {clusters.map((cluster) => (
              <Card key={cluster.name} className="border border-border transition-colors hover:border-accent/40">
                <CardContent className="flex h-full flex-col gap-4 p-5">
                  <div className="flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><Network className="h-5 w-5" /></span>
                    <div className="min-w-0 flex-1">
                      <h2 className="break-words font-semibold leading-tight">{cluster.displayName || cluster.name}</h2>
                      <p className="mt-1 break-all font-mono text-xs text-muted">{cluster.name}</p>
                    </div>
                    {cluster.name === currentCluster && <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">Selected</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", cluster.phase === "Healthy" ? "bg-success/10 text-success" : cluster.phase === "Unhealthy" ? "bg-danger/10 text-danger" : "bg-default/60 text-muted")}>
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                      API: {cluster.phase || "Unknown"}
                    </span>
                    {cluster.name === "local" && <span className="rounded-full bg-default/60 px-2.5 py-1 text-xs text-muted">Central cluster</span>}
                  </div>
                  <div className="space-y-2 text-sm text-muted">
                    {cluster.serverVersion && <div className="flex items-center gap-2"><Cpu className="h-4 w-4 shrink-0" /><span>Kubernetes {cluster.serverVersion}</span></div>}
                    {cluster.lastCheckTime && <div className="flex items-center gap-2"><Clock className="h-4 w-4 shrink-0" /><span>Last checked {formatRelative(cluster.lastCheckTime)}</span></div>}
                    {cluster.message && <p className="break-words rounded-lg bg-default/40 px-3 py-2 text-xs">{cluster.message}</p>}
                  </div>
                  <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-4">
                    <Button size="sm" onPress={() => void openCluster(cluster.name, "/servers")} aria-label={`View servers in ${cluster.displayName || cluster.name}`}>View servers</Button>
                    {cluster.canViewInventory === true && <Button size="sm" variant="outline" onPress={() => void openCluster(cluster.name, "/cluster")} aria-label={`View nodes in ${cluster.displayName || cluster.name}`}>View nodes</Button>}
                    {cluster.name !== "local" && can(me, "cluster:manage") && <Button size="sm" variant="ghost" className="ml-auto text-danger" onPress={() => { remove.reset(); setRemoveTarget(cluster.name); }} aria-label={`Remove cluster ${cluster.displayName || cluster.name}`}><Trash2 className="h-4 w-4" /> Remove</Button>}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
