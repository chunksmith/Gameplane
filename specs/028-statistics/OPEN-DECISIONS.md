# Open decisions: Statistics

Unsettled values. They are recorded here so that nothing below is mistaken for a settled contract.

1. **Remote clusters.** The statistics routes are home-cluster only (501 for a remote `?cluster=`), because `metrics.prometheus.url` is a single install-wide value. To open: a per-Cluster Prometheus URL on the `Cluster` registry entry, or a metrics-server-only fallback for remote clusters.
2. **Physical interface filter.** Node bandwidth excludes virtual devices by a name regex (contract, `PHYS`). Hosts with unusual NIC naming (bonds, VLAN sub-interfaces such as `bond0.100`) may double count or be missed. To open: a Helm override for the regex.
3. **Live endpoint cost.** `/statistics/live` runs about ten instant queries per poll per open browser, with no server-side cache. To open: a short (5s) shared cache keyed by user permission scope, if Prometheus load shows up.
4. **Retention.** The 30d range assumes Prometheus retention of at least 30 days. kube-prometheus-stack defaults to 10 to 15 days, so the older part of the 30d view is empty. To open: hide ranges beyond the retention the API can read from `/api/v1/status/flags`.
5. **Agent gauges.** Player and disk history need Prometheus to scrape the agent (`serviceMonitors.enabled`). Without it, the server tab shows an empty state for players. To open: whether the chart should turn the agent PodMonitor on when `metrics.prometheus.url` is set.
