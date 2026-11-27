---
description: "Task list for Feature 031: Linear issues"
---

# Tasks: Linear issues

**Input**: [spec.md](spec.md), [OPEN-DECISIONS.md](OPEN-DECISIONS.md), and the approved Figma frames (spec.md, Clarifications)

**Prerequisite**: spec 030 (repository builds) merged.

**Tests**: envtest for the new handlers (solve flow with a fake Linear MCP via `aiHandler.dialLinear`), unit test for the prompt addition and the reply-preview pairing, web tests with MSW.

## Phase 1: API

- [ ] T001 Migration `027_linear.sql`: `ai_conversations.linear_issue` + index, table `linear_repo_links`; store methods in `api/internal/db`
- [ ] T002 `api/internal/handlers/ai_linear.go`: `GET /ai/linear/teams`, `GET /ai/linear/issues` with `view` and filters (keep the mention-menu response when no `view`), `GET /ai/linear/issues/{id}`
- [ ] T003 `POST /ai/linear/issues/{id}/solve`: RBAC check, move to the first `started` state, create the repository conversation with `linear_issue`, audit `linear.solve.start`
- [ ] T004 `GET|PUT /ai/linear/links`
- [ ] T005 System prompt addition for conversations with `linear_issue` (both the Messages API and CLI paths)
- [ ] T006 [P] envtest `ai_linear_envtest_test.go` for T002–T004; unit test for T005

## Phase 2: Web

- [ ] T007 `web/src/lib/linear.ts` client and types in `web/src/types.ts`
- [ ] T008 `/linear` route, sidebar entry (only when `linear` is available), tabs, toolbar
- [ ] T009 `web/src/components/linear/`: `IssueList`, `IssueDetail`, `SolveCard`, `RepositoryLinks`
- [ ] T010 Solving view: embed `AssistantPanel` with the repository scope and the linked conversation
- [ ] T011 Assistant: reply-preview approval card for `linear_save_comment` (paired with `save_issue`)
- [ ] T012 Mobile layout (list, full-width detail with `← Issues`, scrolling tabs), light and dark
- [ ] T013 Strings (`web.linear.*`), `npm run i18n:extract`; `Linear.test.tsx` and component tests

## Phase 3: Docs and checks

- [ ] T014 `api/specs.md`, `web/specs.md`, `docs/agent-architecture.md`, `docs/security.md` (solve flow)
- [ ] T015 Compile checks (`go build ./...`, `npx tsc --noEmit`), browser smoke test against `make web-dev`, push; CI verifies
