---
description: "Task list for Feature 026: Server Groups (GameServerSet)"
---

# Tasks: Server Groups

**Input**: `specs/026-server-groups/spec.md`.

**Local verification (rule 8)**: only `go build ./...` (operator, api) and `cd web && npx tsc --noEmit`. CI is the sole test authority.

## Phase 1: CRD

- [ ] T001 [Operator] `GameStorageSpec.Ephemeral` in `operator/api/v1alpha1/gametemplate_types.go`; ephemeral CEL rules on `GameServerSpec` in `operator/api/v1alpha1/gameserver_types.go`.
- [ ] T002 [Operator] `operator/api/v1alpha1/gameserverset_types.go` (GameServerSet, spec, status, list).
- [ ] T003 [Operator] `make generate && make manifests`; commit deepcopy, `operator/config/{crd,rbac}`, `charts/gameplane/crds`/`crd-manifests`.
- [ ] T004 [Chart] Operator and API ClusterRole/Role rules for `gameserversets` in `charts/gameplane/templates/{operator,api}.yaml`.

## Phase 2: Operator

- [ ] T005 Ephemeral data volume: skip `reconcilePVC`, emptyDir in the StatefulSet, set label on pod template (`operator/internal/controller/gameserver_controller.go`).
- [ ] T006 Ephemeral wipe ack (`gameserver_wipe.go`), backup/restore refusal (`backup_controller.go`, `restore_controller.go`).
- [ ] T007 `operator/internal/controller/gameserverset_controller.go` + registration in `operator/cmd/main.go`.
- [ ] T008 Tests: `gameserverset_test.go` (child spec, hash), `gameserverset_envtest_test.go` (scale up/down, ownership, ephemeral volume, CEL).

## Phase 3: API

- [ ] T009 GVR `serversets`, RBAC rule rows, fleet kind `serversets` (`api/internal/kube/client.go`, `api/internal/rbac/rbac.go`, `api/internal/handlers/fleet.go`).
- [ ] T010 Set create/update guard (`api/internal/handlers/serversets.go`, hooks in `resources.go`).
- [ ] T011 Tests: `api/internal/handlers/serversets_envtest_test.go`.

## Phase 4: Web

- [ ] T012 Types, `ServerSets` endpoints, `Fleet.serverSets`, request-client namespace scoping, MSW defaults.
- [ ] T013 Servers page group cards (`web/src/routes/Servers.tsx`, `web/src/lib/serverSets.ts`) + tests.
- [ ] T014 Create wizard group mode, image, ephemeral (`web/src/routes/CreateServer.tsx`); Backups tab hidden for ephemeral (`web/src/routes/ServerDetail.tsx`) + tests.

## Phase 5: Docs

- [ ] T015 `operator/specs.md`, `api/specs.md`, `web/specs.md`.

## Phase 6: StatefulSet mode

- [ ] T016 [Operator] `mode`, `placement`, `replicaPorts`, `minReadySeconds` in `gameserverset_types.go`; `make generate && make manifests`.
- [ ] T017 [Operator] `gameserverset_statefulset.go`, `gameserver_replica.go`, `gameserver_workload.go`; pod template builder shared with standalone servers; tests in `gameserverset_statefulset_test.go`.
- [ ] T018 [API] Replica pod resolution (`ws/target.go`, `ws/podlogs.go`, `ws/actions.go`, `handlers/pod_events.go`), ownership label/owner stripping, `externalIPs` admin guard, lifecycle 409.
- [ ] T019 [Web] Per-replica node pins in the create wizard; start/stop disabled on replicas.
- [ ] T020 [Chart] `deployers[]` + `.github/actions/deploy-server-group`.
