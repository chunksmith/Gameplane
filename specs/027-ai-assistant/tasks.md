---
description: "Task list for Feature 027: AI assistant"
---

# Tasks: AI Assistant

**Input**: `specs/027-ai-assistant/spec.md`

**Tests**: each task names the tests it adds. Verification is CI only (CLAUDE.md rule 8); locally only `go build ./...` and `npx tsc --noEmit`.

**Format**: `[ID] [P?] Description`

## Phase 1: API

- [X] T001 Add migration `api/internal/db/migrations/common/020_ai_assistant.sql` (tables `ai_conversations`, `ai_messages`)
- [X] T002 Add `github.com/anthropics/anthropic-sdk-go` v1.78.0 to `api/go.mod`
- [X] T003 Conversation store, config section `ai`, status, list, create, get, messages, approval, cancel and admin key routes in `api/internal/handlers/ai.go`
- [X] T004 Agent loop, `gameplane_api` tool, scope policy, approval gate and system prompt in `api/internal/handlers/ai_run.go`
- [X] T005 Register `validateAI` in `newValidators` (`api/internal/handlers/config.go`); mount `handlers.MountAI` in the protected group (`api/cmd/main.go`)
- [X] T006 RBAC rules: `/admin/ai` → `config:manage`; `/ai` → any authenticated user (`api/internal/rbac/rbac.go`)
- [X] T007 Tests `api/internal/handlers/ai_test.go`: validation, scope policy, helpers, request params, status and guards, server run, approval, cancel and failures, admin key

## Phase 2: Web

- [X] T008 [P] Client, types and helpers `web/src/lib/assistant.ts`; tests `web/src/lib/assistant.test.ts`
- [X] T009 Panel `web/src/components/assistant/AssistantPanel.tsx`; tests `AssistantPanel.test.tsx`
- [X] T010 Page `web/src/routes/Assistant.tsx`, route `/assistant` (`web/src/router/tree.tsx`); test `web/src/routes/Assistant.test.tsx`
- [X] T011 Sidebar "Assistant" link under General while enabled (`web/src/components/AppLayout.tsx`); test `AppLayout_assistant.test.tsx`
- [X] T012 Server detail "Assistant" tab while enabled (`web/src/routes/ServerDetail.tsx`); test `ServerDetail_assistant.test.tsx`
- [X] T013 Admin settings "AI assistant" section (`web/src/routes/AdminSettings.tsx`, `web/src/components/ui/SettingsNav.tsx`, `web/src/lib/config.ts`); test `AdminSettings_ai.test.tsx`
- [X] T014 Default `/ai/status` MSW handler (disabled) in `web/src/test/handlers.ts`

## Phase 3: Docs

- [X] T015 Document the routes, tables and permission model in `api/specs.md`; the screens in `web/specs.md`

## Phase 4: Subscription credential

- [X] T016 Migration `api/internal/db/migrations/common/021_ai_session.sql` (`ai_conversations.session_id`)
- [X] T017 Add `github.com/modelcontextprotocol/go-sdk` v1.8.0 to `api/go.mod`
- [X] T018 Secret key `oauthToken`, `AIKeyReader` credential kind, subscription branches in create, post, get, approval and cancel (`api/internal/handlers/ai.go`); shared tool schema (`ai_run.go`)
- [X] T019 Claude Code runner, stream-json recording, loopback MCP tool endpoint and approval gate (`api/internal/handlers/ai_cli.go`); tests `ai_cli_test.go`
- [X] T020 Bake Claude Code 2.1.301 into the API image on `distroless/cc` (`api/Dockerfile`)
- [X] T021 Admin "Claude credential" with subscription token (`web/src/routes/AdminSettings.tsx`, `web/src/lib/assistant.ts`, `web/src/lib/config.ts`); test `AdminSettings_ai.test.tsx`
- [X] T022 Document subscription mode in `api/specs.md` and `web/specs.md`
