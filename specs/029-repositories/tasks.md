---
description: "Task list for Feature 029: Repositories"
---

# Tasks: Repositories

**Input**: [spec.md](spec.md), [contracts/repositories-api.md](contracts/repositories-api.md), [OPEN-DECISIONS.md](OPEN-DECISIONS.md), approved Figma frames (spec.md, Clarifications)
**Tests**: envtest for the reconciler and API handlers, unit tests for the agent Git package and token redaction, rbac `TestAllow` cases, web tests with MSW
**Format**: [ID] [P?] Description

## Phase 1: Operator

- [X] T001 `operator/api/v1alpha1/repository_types.go`; `make generate && make manifests`; sync both chart CRD directories (core rule 7)
- [X] T002 `operator/internal/controller/repository_controller.go`: PVC, StatefulSet with the repo agent, Service, agent certificate, status; envtest
- [X] T003 `operator/cmd/main.go`: `--repo-agent-image`; RBAC markers; chart values `repositories.agentImage`

## Phase 2: Repo agent

- [X] T004 Decide the Git engine and pull strategy (settled 2026-10-27: `git` CLI image, rebase)
- [X] T005 `agent/internal/files`: dotfile allowlist option, `.git` always blocked; tests
- [X] T006 [P] `agent/internal/git`: status, diff, stage, unstage, discard, commit, log, show, revert, undo, branches, checkout, fetch, pull, push, clone with progress; per-repo mutex; `GIT_ASKPASS` token handling and output redaction; tests
- [X] T007 `agent/cmd/main.go`: `--mode=repository`; repo agent Dockerfile; `make images` and `make dev-load` entries

## Phase 3: API

- [X] T008 `api/internal/rbac`: `repositories:*` catalog entries, rules, owner/collaborator/network fallback for repositories; `TestAllow`
- [X] T009 `api/internal/handlers/integrations_github.go`: token Secret, GitHub `/user` verification, routes; tests
- [X] T010 `api/internal/handlers/repositories.go`: CRUD, access, collaborators, network, reclone; envtest
- [X] T011 `api/internal/ws`: route `/repositories/{name}/files/*` and `/git/*` to `<repo>-agent`, inject `X-Gameplane-Git-Token` for net routes only
- [X] T012 Audit events for every Git and file write; message ids in `api/internal/messages`; `make i18n-sync`
- [X] T013 Assistant: `repository` column migration, scope authorization, repo file tools, Git tools, approval rules, prompts; tests

## Phase 4: Web

- [X] T014 [P] Types, endpoints, MSW handlers and factories for repositories, Git and the GitHub token
- [X] T015 Target abstraction so the Files tab and the assistant work for servers and repositories; existing server tests stay green
- [X] T016 `/repositories` page, Add repository modal, sidebar item, router
- [X] T017 Repository detail header and tabs; Files tab with Git status letters
- [X] T018 Git tab: Changes (lists, diff, commit box) and History (commit lists, commit detail)
- [X] T019 Settings tab: repository card, network, collaborators, remove
- [X] T020 Integrations GitHub card
- [X] T021 `npm run i18n:extract`; compile checks (`go build ./...`, `npx tsc --noEmit`)

## Phase 5: Docs and E2E

- [X] T022 [P] `operator/specs.md`, `api/specs.md`, `agent/specs.md`, `web/specs.md`, `docs/security.md` (token flow), `docs/agent-architecture.md`
- [X] T023 E2E bucket test with a local Git server fixture (no GitHub in CI); register in `test/e2e/buckets.sh`
