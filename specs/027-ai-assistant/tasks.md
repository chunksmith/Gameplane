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

## Phase 5: Live reply streaming

- [X] T023 Per-conversation frame registry and `GET /ai/conversations/{id}/stream` SSE route (`api/internal/handlers/ai_stream.go`, `ai.go`); exempt the route from the request timeout (`api/cmd/main.go`)
- [X] T024 Stream the Messages API reply (`sendClaude` via `NewStreaming`) and the CLI reply (`--include-partial-messages`, `stream_event` frames) into the registry (`api/internal/handlers/ai_run.go`, `ai_cli.go`)
- [X] T025 `useAssistantStream` and the live assistant bubble (`web/src/lib/assistant.ts`, `web/src/components/assistant/AssistantPanel.tsx`)
- [X] T026 Tests `api/internal/handlers/ai_stream_test.go`, CLI delta case in `ai_cli_test.go`, timeout case in `api/cmd/timeout_test.go`, panel streaming case in `AssistantPanel.test.tsx`; document the route in `api/specs.md` and `web/specs.md`

## Phase 6: Admin shell

- [X] T027 `aiCreds.admin` from the built-in `admin` role (`api/internal/handlers/ai.go`); `Bash` tool, shell prompt and in-cluster env for admin CLI runs (`api/internal/handlers/ai_cli.go`); test `TestAICLIAdminShell` in `ai_cli_test.go`
- [X] T028 `kubectl` 1.37.1 and a `debian:trixie-slim` runtime in `api/Dockerfile`
- [X] T029 Opt-in `api.ai.clusterRole` ClusterRoleBinding (`charts/gameplane/templates/api.yaml`, `charts/gameplane/values.yaml`)
- [X] T030 `BASH <command>` tool-call label (`web/src/lib/assistant.ts`); test in `assistant.test.ts`
- [X] T031 Document the admin shell in `api/specs.md` and `web/specs.md`
- [X] T032 `curl` and `wget` in the API runtime (`buildpack-deps:trixie-curl` in `api/Dockerfile`); `pods/exec` on the API games Role (`charts/gameplane/templates/api.yaml`); shell prompt names curl and wget (`api/internal/handlers/ai_cli.go`); `POST /servers/{name}/mods/install` in the system prompt (`api/internal/handlers/ai_run.go`)

## Phase 7: Permission modes

- [X] T033 `permission_mode` column (`api/internal/db/migrations/common/023_ai_permission_mode.sql`); `defaultMode` setting, `mode` on create and messages, `defaultMode` in status (`api/internal/handlers/ai.go`)
- [X] T034 Bypass skips the approval gate on both paths and mode-specific approval text in the system prompt (`api/internal/handlers/ai_run.go`); `--permission-mode` per mode and mode-specific shell text (`api/internal/handlers/ai_cli.go`)
- [X] T035 Tests: `TestValidateAI`, `TestAIStatusAndGuards`, `TestAIRunBypass` in `ai_test.go`; `TestAICLIModes`, `TestAICLIBypass` in `ai_cli_test.go`
- [X] T036 `ASSISTANT_MODES` and `mode` on create and send (`web/src/lib/assistant.ts`); composer mode picker (`web/src/components/assistant/AssistantPanel.tsx`); admin default permission mode (`web/src/routes/AdminSettings.tsx`, `web/src/lib/config.ts`); tests in `assistant.test.ts`, `AssistantPanel.test.tsx`, `AdminSettings_ai.test.tsx`
- [X] T037 Document the modes in `api/specs.md` and `web/specs.md`

## Phase 8: File tools

- [X] T038 `read_file`, `edit_file`, `write_file` tool specs and handlers (`api/internal/handlers/ai_files.go`); shared `aiTools` list feeds the Messages API tools, the MCP server and `--allowedTools`; `aiMaxResult` 45000, `MaxTokens` 64000, system prompt steers file changes to the tools (`ai_run.go`, `ai_cli.go`)
- [X] T039 Tests `api/internal/handlers/ai_files_test.go` (`TestAINumbered`, `TestAIFileTool`, `TestAIFileToolsRun`, `TestAICLIFileTool`); `cliCall` helper and tool-list assertions in `ai_cli_test.go`, `TestAIParams` in `ai_test.go`
- [X] T040 Web: `INLINE_LIMIT` and `READ|EDIT|WRITE <path>` labels (`web/src/lib/assistant.ts`); files over the limit go by path in the Files tab chat and `@` mentions (`web/src/routes/tabs/FileAssistant.tsx`, `web/src/components/assistant/Mentions.tsx`); tests in `assistant.test.ts`, `FileAssistant.test.tsx`
- [X] T041 Document the file tools in `api/specs.md`, `web/specs.md` and this spec

## Phase 9: Process reuse

- [X] T042 One Claude Code process per conversation (`aiProc`, `--input-format stream-json`, user messages as stdin lines, turn ends at `result`, closed after 10 idle minutes, restarted with `--resume` on a settings change, Stop or a dead process, at most 3 resident with the longest idle evicted) in `api/internal/handlers/ai_cli.go`; `spawn` returns stdin (`api/internal/handlers/ai.go`)
- [X] T043 Tests: stdin-reading fake process in `newCLIFixture`, two turns through one process and the between-turn refusal in `TestAICLIRun`, `TestAICLIProcessRestart` (model change, idle window) and `TestAICLIProcessCap` in `api/internal/handlers/ai_cli_test.go`
- [X] T044 Document the process lifecycle and the 1Gi requirement in `spec.md`, `api/specs.md` and the `api.resources` comment in `charts/gameplane/values.yaml`

## Phase 10: Warm start

- [X] T045 `POST /ai/warm` and `POST /ai/conversations/{id}/warm` start the conversation's CLI process before the first message (`warm` in `api/internal/handlers/ai.go`; `warmCLI`, `adopt`, `aiNewChat` and the warm guard in `process` in `api/internal/handlers/ai_cli.go`); `create` adopts the user's new-chat process
- [X] T046 Web: `Assistant.warm` (`web/src/lib/assistant.ts`), called from `AssistantPanel` on open and on a mode or model change
- [X] T047 Tests: `TestAICLIWarm` (new-chat warm, refused tool call before a message, adoption by `create`, conversation re-warm on a model change with `--resume`, warm then message reuses one process, bad mode, other user) and `TestAICLIWarmBusy` (warm never replaces a process in a turn) in `api/internal/handlers/ai_cli_test.go`
- [X] T048 Document warm start in `spec.md`, `api/specs.md` and `web/specs.md`

## Phase 11: Process cap

- [X] T049 `aiCLIMax` counts busy processes and rises to 10; a run that finds ten processes in a turn fails with `errAICLIFull` (`process` and `runCLI` in `api/internal/handlers/ai_cli.go`); test `TestAICLIProcessCapBusy` in `api/internal/handlers/ai_cli_test.go`
- [X] T050 Document the cap and the 3Gi requirement in `spec.md`, `api/specs.md` and the `api.resources` comment in `charts/gameplane/values.yaml`

## Phase 12: Server shell and archive tools

- [X] T051 `read_archive` tool (`readArchive`, `aiArchiveListing` in `api/internal/handlers/ai_files.go`) and the last-resort jar rule plus the ported Claude Code working rules in `aiSystemPrompt` (`api/internal/handlers/ai_run.go`)
- [X] T052 `POST /servers/{name}/shell` (`mountShell`, `execShell` in `api/internal/ws/exec.go`, mounted by `MountWithPlayerNames` with `AgentGatewayOptions.Auditor` from `api/cmd/main.go`) with audit of the command; tests in `api/internal/ws/exec_test.go`
- [X] T053 `shell` assistant tool (`shell`, `aiShellOutput`, `aiCheckServer` in `api/internal/handlers/ai_files.go`), prompt rules, `ARCHIVE` label in `web/src/lib/assistant.ts`; tests in `api/internal/handlers/ai_files_test.go`
- [X] T054 Document both tools in `spec.md` and `api/specs.md`

## Phase 13: Claude Code tools

- [X] T055 API tools (`ai_tools.go`, `ai_files.go`, `ai_cli.go`, `ai_run.go`, `ai.go`): `grep`, `glob`, background `shell` with `shell_output` and `shell_stop`, `web_fetch` (`netguard.IsPublic`), `todo_write`, `ask_user` with `POST /ai/conversations/{id}/answer` and the `ASK` pending entry, `propose_plan` with the `PLAN` entry and plan mode, subagent `parent` messages, built-in `Task`/`WebSearch` (plus `Bash`, `Monitor`, `TaskStop` for admins) in `--tools` and `--allowedTools`
- [X] T056 Tests: `api/internal/handlers/ai_tools_test.go` and updated tool-list and `--tools`/`--allowedTools` assertions in `ai_cli_test.go`, `ai_test.go` and `ai_files_test.go`
- [X] T057 Web cards: Grep/Glob, web search, fetch and background rows, Tasks, Subagent, Question and Plan cards (`web/src/components/assistant/ToolCards.tsx`, `web/src/components/assistant/AssistantPanel.tsx`, `web/src/lib/assistant.ts`); plan mode with mode hints in the composer
- [X] T058 Tests: `ToolCards.test.tsx`, `AssistantPanel.test.tsx` and `assistant.test.ts` cover the new cards, the answer call and plan mode hints
- [X] T059 Document the tools in `spec.md`, `api/specs.md`, `web/specs.md` and `docs/security.md` (`web_fetch` as an `IsPublic` sink; plan mode is a UX guard, not an authorization boundary)
