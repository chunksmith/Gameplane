# Feature Specification: AI Assistant

**Feature Branch**: `feat/ai-assistant`

**Created**: 2026-10-16

**Status**: In progress

**Input**: Maintainer request (2026-10-16, in chat): a prompt box on the server page (and a server-independent one under "General" in the sidebar) whose prompts act on the server ("change Y in plugin X"). Claude only. A server prompt may act only on that server; every action must stay within the user's own permissions (for example, a backup delete is refused when the user may not delete backups). Prompts are recorded. The admin picks the default model and effort.

## Clarifications

### Session 2026-10-16 (maintainer, in chat)

- Q: Who provides the Claude credential? → A: The admin, once, for the whole install; it applies to every user. Settled.
- Q: Can a personal Claude subscription (Pro/Max) be used instead of an API key? → A: No. Anthropic does not allow third-party products to offer claude.ai login or subscription limits; the panel uses a Claude Console API key (pay-as-you-go). Settled.
- Q: Who may use the assistant? → A: Every signed-in user while the admin has it enabled; what it can do is limited by that user's own permissions. Settled (a per-role `ai:use` permission is out of scope).

## Design

### Model access

- Anthropic Go SDK (`github.com/anthropics/anthropic-sdk-go`), beta Messages API, one custom tool `gameplane_api`.
- Models: `claude-opus-5-5` (default), `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`. Effort: `low`, `medium` (default), `high`, `xhigh`, `max` via `output_config.effort`. Thinking is left at the model default (adaptive).
- Server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) on every model except Haiku. A `refusal` stop reason ends the turn with an error.

### Permission model

- Every tool call is an in-process request through the API's own router carrying the user's session cookie, CSRF header and client IP. Authentication, rate limiting, RBAC (role bindings, owner/collaborator/network fallback, admin-only backup delete) and the audit log apply exactly as for the dashboard. A 403 is returned to the model, which reports it.
- The assistant never reaches: `/auth`, `/users` (except `GET /users/me`), `/roles`, `/networks`, `/admin`, `/clusters`, `/ai`, `/events`, `/shares`, `/ws`, cluster writes, tunnel credentials, captures, ownership changes (`:transfer`, `:collaborators`, `:network`) and binary transfers (`files/download|archive|upload`, `mods/upload`, `logs/download`).
- General conversations reach `servers`, `serversets`, `backups`, `schedules`, `restores` (read/write) and `templates`, `fleet`, `namespaces`, `modules`, `cluster`, `backup-destinations` (GET only).
- Server conversations are pinned to one server: `namespace` and `cluster` are forced on every call; only `/servers/{server}…`, `GET /templates/…` and the server's own backups, schedules and restores (`spec.serverRef.name`) are reachable; list reads of those kinds are filtered to the server.
- Approval: `DELETE`, `:wipe-data` and `POST /restores` pause the run (`awaiting_approval`) until the user approves or declines in the panel. Declined calls return an error result to the model.

### Records

- Tables `ai_conversations` (owner, scope, model, effort, status, error, token usage, timestamps) and `ai_messages` (Anthropic message JSON per turn, append-only). Kept when the conversation ends; there is no delete endpoint.
- Every tool call is also an ordinary audit event under the user's name.
- Users see their own conversations; holders of `audit:read` can list everyone's (`scope=all`).

### API

- `GET /ai/status` → `{enabled, configured, defaultModel, defaultEffort}`.
- `GET /ai/conversations?server=&namespace=&cluster=` (own, exact scope; empty = general) or `?scope=all`.
- `POST /ai/conversations {prompt, server?, namespace?, cluster?, model?, effort?}` → 201, run starts in the background.
- `GET /ai/conversations/{id}` → `{conversation, messages, pending}`.
- `POST /ai/conversations/{id}/messages {prompt}`, `POST …/approval {approve}`, `POST …/cancel`. Only the owner may write; a run in progress → 409.
- RBAC: `/ai` needs any authenticated user; `/admin/ai` needs `config:manage`.
- Admin: config section `ai` `{enabled, defaultModel, defaultEffort, apiKeySet}`; key stored in the labelled Secret `gameplane-ai` (`gameplane.local/ai=true`, key `apiKey`) via `PUT/DELETE /admin/ai/secret`.
- Runs execute in a background goroutine (max 40 model calls per turn); the web polls while a run is active. A run interrupted by an API restart is marked `error` at startup.

### Web

- Sidebar "General" → "Assistant" (`/assistant`), shown while the assistant is enabled; conversation history with an admin "All users" toggle.
- Server detail → "Assistant" tab with the same panel scoped to the server.
- Panel: conversation list, transcript (text, tool calls with method/path/status), approval card, stop button, composer. New conversations use the admin's default model and effort (the API also accepts `model`/`effort` per conversation; the panel has no picker).
- Admin settings → "AI assistant": enable switch, API key (write-only), default model and effort.

## Out of scope

- Using a Claude.ai subscription (see Clarifications).
- Console (RCON/PTY) commands; streaming token output; per-role `ai:use` permission; deleting conversation records.
