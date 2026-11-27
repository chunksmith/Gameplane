---
description: "Task list for Feature 030: Repository builds"
---

# Tasks: Repository builds

**Input**: [spec.md](spec.md), [data-model.md](data-model.md), [contracts/builds-api.md](contracts/builds-api.md), [OPEN-DECISIONS.md](OPEN-DECISIONS.md), and the approved Figma frames (spec.md, Clarifications)

**Tests**:
- envtest for both reconcilers and the API handlers;
- unit tests for the log-marker parser, deploy validation, and assistant `authorize` and `needsApproval`;
- web tests with MSW.

**Format**: [ID] [P?] Description

## Phase 1: Operator

- [X] T001 `operator/api/v1alpha1/repositorybuild_types.go`; add `spec.build` and `status.cacheClearedAt` in `repository_types.go`; run `make generate && make manifests`; sync both chart CRD directories (core rule 7)
- [X] T002 `repository_controller.go`: `<repo>-build-cache` PVC and the clear-cache annotation flow; extend the envtest
- [X] T003 `repositorybuild_controller.go`:
  - queueing;
  - the per-build Secret (script, `settings.xml`, Gradle init, tokens; the write token only when publishing);
  - the Job (affinity, mounts, sandbox, deadline);
  - mirroring Job status;
  - log-marker parsing;
  - retention.
- [X] T004 [P] Unit test for the marker parser and the build script's tool detection; envtest `repositorybuild_envtest_test.go` (affinity, security context, write token only with publish, status, queue, retention)
- [X] T005 `operator/cmd/main.go` build flags; RBAC markers for `repositorybuilds` and `jobs`

## Phase 2: Chart

- [X] T006 `charts/gameplane/templates/maven.yaml`: Reposilite Deployment, PVC (keep), Service, optional Ingress, and the token bootstrap hook Job with its three Secrets
- [X] T007 `values.yaml`: `mavenRepository.*` and `repositories.build.*`; operator args in `templates/operator.yaml`
- [X] T008 `networkpolicies.yaml`:
  - `gameplane-build` joins public egress;
  - build → maven egress;
  - maven ingress from build, API and the ingress controller.

## Phase 3: API

- [X] T009 `api/internal/handlers/repository_builds.go`: list, start, get, delete, log stream, clear-cache, build settings; message ids in `api/internal/messages`; `make i18n-sync`
- [X] T010 Deploy:
  - validation and the SHA-256 check;
  - per-target replay (upload, delete, restart), at most 4 in parallel;
  - the result list, the audit entry and the deployments annotation.
- [X] T011 `GET /integrations/maven`
- [X] T012 [P] envtest for builds and deploy, including a forbidden target, a partial failure and `artifact_changed`

## Phase 4: Assistant

- [X] T013 `api/internal/handlers/ai_builds.go`:
  - the five build tools;
  - `aiScopeTools` for repository scope;
  - `builds/` in the repository prefix check;
  - `build_deploy` in `needsApproval`;
  - plan-mode blocking;
  - the initiative rule in the prompt.
- [X] T014 Cross-target reads:
  - `server` / `repository` arguments on `read_file`, `list_files` and the Git reads;
  - `repositories_list`;
  - GET-only `authorize` for other targets.
- [X] T015 [P] Table tests for `authorize`, `needsApproval` and plan mode
- [X] T016 `web/src/lib/assistant.ts`: labels and views for the new tools; render the `build_deploy` approval card

## Phase 5: Web

- [X] T017 [P] Types, the `Builds` client in `lib/repositories.ts`, MSW handlers and factories
- [X] T018 `web/src/components/ServerPicker.tsx`, extracted from the `NetworkDetail.tsx` servers card; `NetworkDetail` moves to it unchanged
- [X] T019 `repository/BuildsTab.tsx`: toolbar, list, detail, Artifacts, Deployments, live log, mobile stacking; register the tab in `RepositoryDetail.tsx`
- [X] T020 `repository/DeployModal.tsx`: Manual and With Assistant modes; the latter opens the Assistant tab with a seeded conversation
- [X] T021 Build card in `SettingsTab.tsx`; `components/settings/MavenCard.tsx` in Integrations, with the corrected publish copy
- [X] T022 `BuildsTab.test.tsx`, `DeployModal.test.tsx`; `npm run i18n:extract`; compile checks (`go build ./...`, `npx tsc --noEmit`)

## Phase 6: Docs and E2E

- [X] T023 [P] `operator/specs.md`, `api/specs.md`, `web/specs.md`, `docs/security.md` (build sandbox, egress, read and write tokens), `docs/architecture.md`, chart README values
- [X] T024 [P] Website docs: publishing from a laptop with `mvn deploy` / `gradle publish` (commit in `website/`, pointer bump in root)
- [ ] T025 E2E in bucket `multicluster`:
  - a tiny Maven project from the in-cluster Git fixture;
  - build;
  - artifact in status;
  - deploy to a test server's `plugins/`.

  Register it in `test/e2e/buckets.sh`.
- [ ] T026 Manual check on chunksmith after the edge deploy:
  - publish `chicken-utils` and `litteams` from a laptop;
  - LitHomes cold and warm builds;
  - a Manual deploy, then a With Assistant deploy with approval;
  - "build it" must not deploy;
  - a cross-server read, and a refused read.
