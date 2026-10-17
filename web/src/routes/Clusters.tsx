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
import { useOptionalIntl } from "@/lib/i18n/format";
import { defineMessages } from "react-intl";

// The API phase is a machine value; known phases show as labels, others as received.
const clusterPhases = defineMessages({
  healthy: { id: "web.routes.clusters.phase_healthy", defaultMessage: "Healthy", description: "Clusters: API status label for a cluster the panel reports as healthy" },
  unhealthy: { id: "web.routes.clusters.phase_unhealthy", defaultMessage: "Unhealthy", description: "Clusters: API status label for a cluster the panel reports as unhealthy" },
});

function clusterPhaseLabel(intl: ReturnType<typeof useOptionalIntl>, phase: string): string {
  if (phase === "Healthy") return intl.formatMessage(clusterPhases.healthy);
  if (phase === "Unhealthy") return intl.formatMessage(clusterPhases.unhealthy);
  return phase;
}

export function ClustersPage() {
  const intl = useOptionalIntl();
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
      <PageHeader title={intl.formatMessage({ id: "web.routes.clusters.clusters", defaultMessage: "Clusters", description: "Clusters: page title at the top of the cluster administration page; keep it short" })} description={intl.formatMessage({ id: "web.routes.clusters.administration_of_registered_locations", defaultMessage: "Administration of registered locations, connectivity and node inventory.", description: "Clusters: subtitle under the page title saying the page covers registered locations, their connectivity and node inventory" })}
        actions={can(me, "cluster:manage") && <Button onPress={() => setRegisterOpen(true)}><Plus className="h-4 w-4" /> {intl.formatMessage({ id: "web.routes.clusters.register_cluster", defaultMessage: "Register cluster", description: "Clusters: button at the top right that opens the dialog for registering a new cluster; shown only to users who can manage clusters; keep it short" })}</Button>} />
      {registerOpen && <RegisterClusterDialog open onOpenChange={setRegisterOpen} />}
      <ConfirmDialog open={!!removeTarget} onOpenChange={(open) => {
        if (!open && !remove.isPending) { setRemoveTarget(null); remove.reset(); }
      }} title={intl.formatMessage({ id: "web.routes.clusters.remove_title", defaultMessage: "Remove {name}?", description: "Clusters: title of the remove-cluster confirmation; {name} is the cluster name" }, { name: removeTarget ?? "" })}
        description={<div className="space-y-3">
          <p>{intl.formatMessage({ id: "web.routes.clusters.removes_this_panel_s_connection_to_the", defaultMessage: "Removes this panel's connection to the cluster. Running workloads remain on the cluster.", description: "Clusters: text in the remove-cluster confirmation dialog saying the panel's connection is removed while running workloads stay on the cluster" })}</p>
          {remove.error && <p role="alert" className="text-danger">{intl.formatMessage({ id: "web.routes.clusters.couldn_t_remove_the_cluster", defaultMessage: "Couldn't remove the cluster registration. Try again.", description: "Clusters: error message in the remove-cluster dialog shown when removing the registration fails; the user can try again" })}</p>}
        </div>}
        confirmLabel={intl.formatMessage({ id: "web.routes.clusters.remove_cluster", defaultMessage: "Remove cluster", description: "Clusters: confirm button in the remove-cluster dialog, shown in a destructive style; keep it short" })} destructive busy={remove.isPending} onConfirm={() => removeTarget && remove.mutate(removeTarget)} />
      {!isLoading && !error && !can(me, "cluster:manage") && !clusters.some((item) => item.canViewInventory) ? (
        <ErrorCard message={intl.formatMessage({ id: "web.routes.clusters.cluster_administration_requires", defaultMessage: "Cluster administration requires inventory or cluster-management access.", description: "Clusters: error card shown instead of the cluster list to users who have neither cluster management nor inventory access" })} />
      ) : isLoading ? (
        <LoadingCard message={intl.formatMessage({ id: "web.routes.clusters.loading_clusters", defaultMessage: "Loading clusters…", description: "Clusters: loading text shown while the list of registered clusters is being fetched" })} />
      ) : error ? (
        <ErrorCard message={intl.formatMessage({ id: "web.routes.clusters.couldn_t_load_registered_clusters_try", defaultMessage: "Couldn't load registered clusters. Try again.", description: "Clusters: error card shown when the cluster list fails to load; a retry button appears below it" })} onRetry={() => void refetch()} />
      ) : clusters.length === 0 ? (
        <Card className="border border-border"><EmptyState icon={<Network />} title={intl.formatMessage({ id: "web.routes.clusters.no_clusters_available", defaultMessage: "No clusters available", description: "Clusters: heading of the empty-state card shown when no cluster is registered or visible to the user" })} hint={can(me, "cluster:manage") ? intl.formatMessage({ id: "web.routes.clusters.register_workload_cluster_hint", defaultMessage: "Register a workload cluster to deploy and manage game servers. This panel can run without a local cluster.", description: "Clusters: empty-state hint shown to users who can manage clusters" }) : intl.formatMessage({ id: "web.routes.clusters.ask_administrator_for_access", defaultMessage: "Ask your administrator for access to a registered cluster.", description: "Clusters: empty-state hint shown to users without cluster-management access" })} /></Card>
      ) : (
        <>
          <p className="text-sm text-muted">{intl.formatMessage({ id: "web.routes.clusters.available_status_reports_kubernetes_api", defaultMessage: "{count, plural, one {{count} cluster} other {{count} clusters}} available · Status reports Kubernetes API connectivity, not game or gateway health.", description: "Clusters: count of registered clusters followed by a note that status reflects Kubernetes API connectivity; {count} is the number of clusters" }, { count: clusters.length })}</p>
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
                    {cluster.name === currentCluster && <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">{intl.formatMessage({ id: "web.routes.clusters.selected", defaultMessage: "Selected", description: "Clusters: small badge on a cluster card marking the cluster currently selected; keep it short" })}</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", cluster.phase === "Healthy" ? "bg-success/10 text-success" : cluster.phase === "Unhealthy" ? "bg-danger/10 text-danger" : "bg-default/60 text-muted")}>
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                      {intl.formatMessage({ id: "web.routes.clusters.api", defaultMessage: "API:", description: "Clusters: label before the API health value on a cluster card, such as Healthy or Unhealthy; the value is colored by its state; keep it short" })} {cluster.phase ? clusterPhaseLabel(intl, cluster.phase) : intl.formatMessage({ id: "web.routes.clusters.phase_unknown", defaultMessage: "Unknown", description: "Clusters: API status shown when the cluster reports no phase" })}
                    </span>
                    {cluster.name === "local" && <span className="rounded-full bg-default/60 px-2.5 py-1 text-xs text-muted">{intl.formatMessage({ id: "web.routes.clusters.central_cluster", defaultMessage: "Central cluster", description: "Clusters: note on the cluster card of the built-in local cluster that the panel itself runs in" })}</span>}
                  </div>
                  <div className="space-y-2 text-sm text-muted">
                    {cluster.serverVersion && <div className="flex items-center gap-2"><Cpu className="h-4 w-4 shrink-0" /><span>{intl.formatMessage({ id: "web.routes.clusters.kubernetes_serverversion", defaultMessage: "Kubernetes {serverVersion}", description: "Clusters: sentence with serverVersion in p" }, { serverVersion: cluster.serverVersion })}</span></div>}
                    {cluster.lastCheckTime && <div className="flex items-center gap-2"><Clock className="h-4 w-4 shrink-0" /><span>{intl.formatMessage({ id: "web.routes.clusters.last_checked", defaultMessage: "Last checked", description: "Clusters: label before the time of the last health check on a cluster card; the relative time follows it" })} {formatRelative(cluster.lastCheckTime, intl)}</span></div>}
                    {cluster.message && <p className="break-words rounded-lg bg-default/40 px-3 py-2 text-xs">{cluster.message}</p>}
                  </div>
                  <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-4">
                    <Button size="sm" onPress={() => void openCluster(cluster.name, "/servers")} aria-label={intl.formatMessage({ id: "web.routes.clusters.view_servers_in", defaultMessage: "View servers in {name}", description: "Clusters: accessible label of the View servers button; {name} is the cluster display name" }, { name: cluster.displayName || cluster.name })}>{intl.formatMessage({ id: "web.routes.clusters.view_servers", defaultMessage: "View servers", description: "Clusters: button on a cluster card that opens the server list for that cluster; keep it short; its screen-reader name also includes the cluster name" })}</Button>
                    {cluster.canViewInventory === true && <Button size="sm" variant="outline" onPress={() => void openCluster(cluster.name, "/cluster")} aria-label={intl.formatMessage({ id: "web.routes.clusters.view_nodes_in", defaultMessage: "View nodes in {name}", description: "Clusters: accessible label of the View nodes button; {name} is the cluster display name" }, { name: cluster.displayName || cluster.name })}>{intl.formatMessage({ id: "web.routes.clusters.view_nodes", defaultMessage: "View nodes", description: "Clusters: button on a cluster card that opens the node inventory for that cluster; shown only when the user can view inventory; keep it short" })}</Button>}
                    {cluster.name !== "local" && can(me, "cluster:manage") && <Button size="sm" variant="ghost" className="ml-auto text-danger" onPress={() => { remove.reset(); setRemoveTarget(cluster.name); }} aria-label={intl.formatMessage({ id: "web.routes.clusters.remove_cluster_named", defaultMessage: "Remove cluster {name}", description: "Clusters: accessible label of the Remove button; {name} is the cluster display name" }, { name: cluster.displayName || cluster.name })}><Trash2 className="h-4 w-4" /> {intl.formatMessage({ id: "web.routes.clusters.remove", defaultMessage: "Remove", description: "Clusters: button on a cluster card that removes its registration; not shown for the local cluster; keep it short" })}</Button>}
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
