# Feature Specification: Server Groups (GameServerSet)

**Feature Branch**: `feat/server-groups`

**Created**: 2026-10-15

**Status**: In progress

**Input**: Maintainer request (2026-10-15, in chat): run one image as N replicas (e.g. a lobby), with no PVC so every restart starts clean; show the replicas grouped under one entry in the Servers list that expands into per-replica cards, each openable for logs/console; spread the replicas over several selected nodes.

## Clarifications

### Session 2026-10-15 (maintainer, in chat)

- Q: How is each replica reached? → A: Every replica gets its own Service/port (`<set>-0`, `<set>-1`, …), the same as a standalone server. A proxy (Velocity/Bungee) registers each one. No shared load-balanced address.
- Q: How are replicas placed on the selected nodes? → A: Only on the selected nodes, spread across them when possible (preferred pod anti-affinity). When replicas outnumber nodes, a node may run more than one.

### Session 2026-10-16 (review decisions)

- Q: Who may delete a group or lower its replicas? → A: The set's owner or an admin, as for a server delete, whatever namespace permission the caller holds. Scale-down deletes children, so a PUT that lowers `spec.replicas` takes the same check; raising replicas or other edits need `servers:write`. Settled.
- Q: Are group reads password-redacted? → A: Yes, with GameServer parity: password-type `spec.template.config` values read as the redaction marker on GET, POST/PUT replies, `/fleet/serversets` and the `/events` stream, and the last-applied-configuration annotation is dropped. PUT restores marker values from the stored set; POST drops them. Settled.

## Design

### Operator

- New namespaced CRD `GameServerSet` (`gameplane.local/v1alpha1`, short name `gss`, scale subresource):
  - `spec.replicas` (0–100, default 1), `spec.nodes` (node names, optional), `spec.template` (a full `GameServerSpec`).
  - `status.replicas`, `status.readyReplicas` (children in phase Running), `status.observedGeneration`.
  - Name at most 40 characters (child names and their derived object names must stay within DNS limits).
- `GameServerSetReconciler` keeps children named `<set>-<index>` for `index < replicas`; deletes higher indexes on scale-down.
  - Children carry label `gameplane.local/server-set=<set>`, a controller ownerReference to the set (deleting the set garbage-collects them), and copy the set's `gameplane.local/owner-id`, `gameplane.local/owner` and `gameplane.local/network` annotations at creation so the existing owner/collaborator fallback applies.
  - Child spec = template, with `networking.address` and `networking.portOverrides[].nodePort` cleared (they would collide between replicas), a required node affinity on `metadata.name In spec.nodes` when nodes are set, and a preferred (weight 100) pod anti-affinity on the set label over `kubernetes.io/hostname`.
  - A child's spec is rewritten only when the template hash (`gameplane.local/server-set-hash`) changes; the child's own `spec.suspend` is preserved, so per-replica Start/Stop/Restart keep working.
- `GameServer.spec.storage.ephemeral` (bool): the primary data volume is an `emptyDir` and no `<name>-data` PVC is created. Data is lost on every stop, restart, reschedule or wipe. Extra and mod volumes stay persistent. No effect on a GameTemplate.
  - CEL: immutable after creation; cannot be combined with `backupPolicy` or `storage.dataSource`.
  - Data wipe on an ephemeral server acknowledges as soon as the pod is gone (no Job).
  - Backups and restores targeting an ephemeral server fail with a clear message.
- Pod template of a set child also carries `gameplane.local/server-set` (template labels only, never the immutable selector) so the anti-affinity can match.

### API

- `/serversets` generic CRUD (GVR `gameserversets`), RBAC reuses `servers:read` / `servers:write`. DELETE, and a PUT that lowers `spec.replicas`, are owner-or-admin (Session 2026-10-16); DELETE pins the live UID and resourceVersion.
- Create: gameplane annotations stripped and the caller stamped as owner, like servers. Create and update run the GameServer spec guard (`validateAndProtectGameServer`) against `spec.template` (image, serviceAccountName, capture, env Secret refs need the same privileges; templateRef immutable → 409).
- Reads, POST/PUT replies, `GET /fleet/serversets` and the `/events` stream (`serversets` to `servers:read` holders) redact password-type `spec.template.config` values as GameServers do (`api/specs.md`, "GameServer config password redaction").
- `GET /fleet/serversets`, permission-filtered by `servers:read`.

### Web

- Servers page: children (controller ownerReference kind `GameServerSet`) are pulled out of the flat list into a "Server groups" section of collapsible group cards: game icon, name, location, ready/desired, players, node count, scale −/+ and delete. Expanding shows one card per replica (phase, address, players, memory, node, Start/Stop/Restart/menu) linking to the normal server detail page.
- Create wizard: a "Single server / Server group" switch on the Configure step. Group mode adds replicas, a multi-node picker and posts a `GameServerSet`. Both modes get an optional container image and an "Ephemeral storage" switch (default on for groups).
- Server detail hides the Backups tab for ephemeral servers.

## Out of scope

- A shared load-balanced address for a group.
- Autoscaling.
- Per-group collaborators/transfer endpoints (children inherit the set owner at creation).
