# Feature Specification: AI Assistant

**Feature Branch**: `feat/ai-assistant`

**Created**: 2026-10-16

**Status**: In progress

**Input**: Maintainer request (2026-10-16, in chat): a prompt box on the server page (and a server-independent one under "General" in the sidebar) whose prompts act on the server ("change Y in plugin X"). Claude only. A server prompt may act only on that server; every action must stay within the user's own permissions (for example, a backup delete is refused when the user may not delete backups). Prompts are recorded. The admin picks the default model and effort.

## Clarifications

### Session 2026-10-16 (maintainer, in chat)

- Q: Who provides the Claude credential? → A: The admin, once, for the whole install; it applies to every user. Settled.
- Q: Can a personal Claude subscription (Pro/Max) be used instead of an API key? → A: Yes, as an alternative credential (revised 2026-10-16, maintainer in chat). The admin stores a token from `claude setup-token`; the API then runs the unmodified Claude Code CLI with it. Anthropic's terms allow signing in to the unmodified Claude Code binary with one's own subscription but ask products to use API keys; the maintainer accepted that ambiguity for this single-user install. Sharing the subscription with other people is clearly not allowed. Settled.
- Q: Who may use the assistant with a subscription token? → A: The same users as with an API key (every signed-in user while enabled); the maintainer is the install's only user. Settled.
- Q: Who may use the assistant? → A: Every signed-in user while the admin has it enabled; what it can do is limited by that user's own permissions. Settled (a per-role `ai:use` permission is out of scope).

### Session 2026-10-17 (maintainer, in chat)

- Q: Should admins reach Kubernetes directly? → A: Yes. In subscription mode, runs of users with the built-in `admin` role get Claude Code's Bash tool and `kubectl`, without approval, so they can open a shell or run `kubectl exec`. The maintainer accepted the risk because only admins get it. Settled.

### Session 2026-10-18 (maintainer, in chat)

- Q: Should the assistant have permission modes like Claude Code? → A: Yes. Three modes: `default` (deletes, data wipes and restores wait for approval, as before), `auto` (Claude Code's auto mode: its classifier approves safe shell commands and blocks risky ones; panel approvals stay) and `bypassPermissions` (nothing waits for approval, the CLI never refuses a shell or `kubectl` command, and the model does not ask for confirmation). The admin picks the default; each user picks the mode per conversation in the composer and can change it with the next message. Settled.

### Session 2026-10-23 (maintainer, in chat)

- Q: Should the assistant reach Linear? → A: Yes, through Linear's MCP server, configured in Admin settings; typing `@linear` gives the assistant the whole workspace (so it can answer questions such as "how many issues are open?") and `@linear ABC-123` points at one issue. The Linear logo shows on the mention menu, attachment cards and tool calls. Figma frames approved: `Gameplane Dashboard` → `Assistant / Composer / Linear mention / *`, `Assistant / Thread / Linear * / *`, `Admin / Settings / Linear MCP card / *` (dark, light, mobile). Settled.

### Session 2026-10-25 (maintainer, in chat)

- Q: The assistant is far slower than Claude Code and refuses a 140 KB plugin file as "too long"; can file access work the way Claude Code reads and writes? → A: Yes. Every file change went through `files/write` with the whole file as the tool input (a 140 KB translation meant ~50k output tokens per save), reads were cut at 60000 bytes (and Claude Code stores MCP results over 50,000 characters in a file the CLI could not read with built-in tools off), and the Files tab pasted the whole file into every prompt, where the 20000-character prompt limit rejected it. The assistant now gets Claude Code-shaped file tools (`read_file` paged with line numbers, `edit_file` by exact old/new string, `write_file`), tool results stay under 45000 bytes, and the web passes files over 12000 characters by path instead of inline. Settled.
- Q: Follow-up messages still feel slower than local Claude Code; where does the time go? → A: Measured from `ai_messages` timestamps on 2026-10-25, the median from a user message to the first model output was 5.2 s, of which 2–3 s was the CLI start and MCP connect repeated on every message (tool round trips average 0.09 s). The API now keeps one Claude Code process per conversation, fed over stdin, and starts a new one only on a settings change, Stop, a dead process, 10 idle minutes or eviction (see Process lifecycle). Settled.

### Session 2026-10-27 (maintainer, in chat)

- Q: The assistant lacks several Claude Code tools (subagents, web search, task list, background commands, grep/glob, asking the user, plan mode); which should it get? → A: Add Task subagents, WebSearch, the task list, background commands (admin Bash with Monitor and TaskStop, and the game shell), Grep and Glob, AskUserQuestion and plan mode. Built-in CLI tools only in subscription mode. WebFetch becomes our own MCP tool `web_fetch` behind `netguard.IsPublic`, because the built-in one would dial from the API pod into the cluster. Grep, Glob, AskUserQuestion and plan mode are MCP tools (`ask_user` and `propose_plan` only on the CLI path) because the built-ins act on the API container or need an interactive terminal. Plan mode is a fourth permission mode. Settled. Revised 2026-10-28: Claude Code background tasks are off (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`), because work that outlived the turn had no tool access and its later output desynced the reused process; subagents and admin `Bash` run in the foreground.

## Design

### Model access

- Anthropic Go SDK (`github.com/anthropics/anthropic-sdk-go`), beta Messages API, custom tools `gameplane_api`, `read_file`, `edit_file` and `write_file` (`aiTools` in `api/internal/handlers/ai_files.go`).
- File tools (both credential paths): `read_file {file_path, offset?, limit?}` returns `cat -n`-style numbered lines, 2000 at a time, lines clipped at 2000 characters, with a `continue with offset=N` trailer when more follow; `edit_file {file_path, old_string, new_string, replace_all?}` reads the file, requires `old_string` to match exactly once (or `replace_all`) and writes the result back; `write_file {file_path, content}` creates or overwrites. General conversations also take `server`, `namespace` and `cluster`; server conversations ignore them. Each tool is a `files/read` and `files/write` call through `authorize` and the in-process router, so RBAC, server pinning and the audit log apply unchanged, and no file write waits for approval (as `files/write` never did). Tool results are cut at 45000 bytes (`aiMaxResult`) so the CLI never spills them into a file. `MaxTokens` on the Messages API path is 64000 (streamed).
- Models: `claude-opus-5-5` (default), `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`. Effort: `low`, `medium` (default), `high`, `xhigh`, `max` via `output_config.effort`. Thinking is left at the model default (adaptive).
- Server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) on every model except Haiku. A `refusal` stop reason ends the turn with an error.
- Subscription mode: when the Secret holds `oauthToken`, the API runs `/usr/local/bin/claude -p` (Claude Code 2.1.301, baked into the API image) with `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, `--input-format stream-json`, `--output-format stream-json`, `--model`, `--effort`, `--max-turns 40` (counted per user message in this mode), the panel system prompt (`--system-prompt`), built-in tools `Task,WebSearch` (`--tools`; admins also get `Bash,Monitor,TaskStop` outside plan mode), allowed tools the `mcp__gameplane__*` tools plus those built-ins, `--permission-mode` from the conversation's mode (see Permission modes; see Claude Code tools for the new tools), and `--resume <session_id>` whenever a conversation's process is started again. Claude Code's state lives in `/data/claude`.
- Process lifecycle (revised 2026-10-25): one CLI process per conversation, started by the first message and kept for the next ones. Each user message is one JSON line on its stdin (`{"type":"user","message":{"role":"user","content":"<prompt>"},"parent_tool_use_id":null}`); the turn ends at the `result` event and the process waits for the next message. The process is closed (stdin closed, killed after 5 s if still running) after 10 minutes without a message, when the next message changes anything it was started with (model, effort, permission mode, the admin flag, the subscription token or the Linear tool list), when a turn ends without a `result`, and at once when the user presses Stop; the next message starts a new process with `--resume`. At most three processes stay resident per API; when a fourth conversation needs one, the longest-idle process is closed first (a process in a turn is never closed for this, so briefly more may exist). A start costs about 2–3 s (process start plus MCP connect), which follow-up messages in a live conversation now skip. Warm start (added 2026-10-25): the panel asks the API to start the process when the user opens a conversation or a new chat (and again when the mode or model changes), so the first message also skips the start; a new chat's process waits under a per-user slot until the first message creates the conversation. Warming never touches a process that is in a turn, uses the same 10-minute idle window and counts toward the three resident processes.
- The CLI reaches `gameplane_api` and the file tools over MCP (streamable HTTP, stateless) on a listener bound to `127.0.0.1` inside the API process. Each process gets a random bearer token that stays valid while it lives; tool calls outside a turn are refused ("this assistant run has ended"). The tool runs the same `authorize` and in-process router call as API-key mode.
- The CLI runs inside the API container and at most ten processes run at once, busy ones included, each holding 150–250 MB, so subscription mode needs `api.resources.limits.memory` of at least 3Gi; the chart default stays 256Mi (see the comment on `api.resources` in `charts/gameplane/values.yaml`).

### Permission model

- Every tool call is an in-process request through the API's own router carrying the user's session cookie, CSRF header and client IP. Authentication, rate limiting, RBAC (role bindings, owner/collaborator/network fallback, admin-only backup delete) and the audit log apply exactly as for the dashboard. A 403 is returned to the model, which reports it.
- Through `gameplane_api` the assistant never reaches: `/auth`, `/users` (except `GET /users/me`), `/roles`, `/networks`, `/admin`, `/clusters`, `/ai`, `/events`, `/shares`, `/ws`, cluster writes, tunnel credentials, captures, ownership changes (`:transfer`, `:collaborators`, `:network`) and binary transfers (`files/download|archive|upload`, `mods/upload`, `logs/download`).
- General conversations reach `servers`, `serversets`, `backups`, `schedules`, `restores` (read/write) and `templates`, `fleet`, `namespaces`, `modules`, `cluster`, `backup-destinations` (GET only).
- Server conversations are pinned to one server: `namespace` and `cluster` are forced on every call; only `/servers/{server}…`, `GET /templates/…` and the server's own backups, schedules and restores (`spec.serverRef.name`) are reachable; list reads of those kinds are filtered to the server.
- Approval: `DELETE`, `:wipe-data` and `POST /restores` pause the run (`awaiting_approval`) until the user approves or declines in the panel. Declined calls return an error result to the model. Not in `bypassPermissions` mode.
- Approval in subscription mode: the tool call blocks until the user approves or declines in the panel (at most 30 minutes, then it counts as declined). Stop kills the CLI process. A conversation waiting for approval when the API restarts becomes `error`.

### Permission modes

- `ai_conversations.permission_mode` (migration `023_ai_permission_mode.sql`, default `default`) holds `default`, `auto` or `bypassPermissions`. `POST /ai/conversations` takes `mode` (otherwise the admin's `defaultMode`); `POST …/messages` takes `mode` to switch it for that run and later ones.
- `default`: approvals as above; the CLI runs with `--permission-mode dontAsk` (allowed tools run, anything the CLI would prompt for is refused).
- `auto`: the CLI runs with `--permission-mode auto`; Claude Code's classifier reviews shell commands and blocks risky ones; panel approvals stay. The Messages API path has no classifier, so `auto` behaves like `default` there.
- `bypassPermissions`: no call waits for approval on either path; the CLI runs with `--permission-mode bypassPermissions`, so shell and `kubectl` commands are never refused, and the system prompt tells the model not to ask for confirmation. RBAC, server pinning and blocked endpoints still apply to `gameplane_api`.
- `plan` (added 2026-10-27): a fourth mode. The API refuses `edit_file`, `write_file`, `shell`, `shell_stop`, `gameplane_api` calls other than GET, and Linear calls that need approval, with the error "Plan mode is on: this call changes something. Finish reading, then call `propose_plan` with your plan." Admins lose `Bash` in plan mode. Approving `propose_plan` switches the conversation's mode to `default` (in the database and the live run). The Messages API path has no `propose_plan`, so the model writes the plan as text.

### Claude Code tools

Added 2026-10-27. Shared `aiTools` entries are offered on both credential paths; `ask_user` and `propose_plan` exist only on the CLI path. The CLI sees the MCP tools as `mcp__gameplane__<name>`; stored transcripts and the web use the bare name.

- `grep {pattern, path?, glob?, ignore_case?, files_only?, server?, namespace?, cluster?}` and `glob {pattern, path?, server?, namespace?, cluster?}` run `grep` and `find` through the game shell, so they need the same permission as `shell` (`servers:write`) and no approval. The game image must ship `find` and `grep`.
- Background jobs: `shell` takes `run_in_background`. The job runs in the game container with its state under `/tmp/gameplane-jobs/<id>.log|.pid|.exit` (`<id>` is 12 lowercase hex characters). `shell_output {job_id, wait_seconds?}` answers with `status: running`, `status: exited <code>` or `status: gone`, a blank line and the last output; `shell_stop {job_id}` stops the job. The admin `Bash` tool has no background jobs: the CLI runs with background tasks off (revised 2026-10-28).
- `web_fetch {url, offset?}` is our own MCP tool, not the built-in WebFetch. It dials through `netguard.IsPublic` (every redirect is checked again), follows at most 5 redirects, reads at most 2 MiB, converts HTML to text and returns pages of 40000 characters; `offset` pages through the text. Web search is the built-in `WebSearch` on the CLI path, for everyone.
- `todo_write {todos: [{content, status}]}` sets the conversation's task list (`pending`, `in_progress` or `completed`) and answers `Todos updated.`; the panel shows it as a Tasks card.
- `ask_user {question, options, multi_select?}` (CLI only) blocks until the user answers in the panel. The answer goes to `POST /ai/conversations/{id}/answer {answer}` (empty = skip): 204 on success, 409 when nothing waits for an answer. While it waits, `pending` lists `{id, method: "ASK", path: ""}`, and the tool answers `The user answered: <answer>` or `The user skipped the question.`
- `propose_plan {plan}` (CLI only, markdown) blocks until the user approves or declines through `POST …/approval`. It answers `The user approved the plan. Plan mode is off: carry it out now.` or `The user did not approve the plan. Ask what they want changed and keep planning.` While it waits, `pending` lists `{id, method: "PLAN", path: ""}`.
- Subagents: the built-in `Task` tool runs subagents. Their stored messages carry a top-level `parent` field with the parent `Task` tool_use id; top-level messages have none. Stored CLI tool blocks keep their CLI names (`Task`, `WebSearch`, `Bash`, `Monitor`, `TaskStop`).

### Admin shell

- Subscription mode only: when the user starting a run has the built-in `admin` role (checked on every run), Claude Code also gets its `Bash` tool (in `--tools` and `--allowedTools`, allowed without approval, outside plan mode) plus `Monitor` and `TaskStop`, which have nothing to act on since background tasks are off (revised 2026-10-28), and a shell section in the system prompt. The Messages API path has no shell.
- The shell runs in the API container as the API user. The runtime image is `buildpack-deps:trixie-curl` (Debian trixie with curl and wget; Bash needs a shell; it was `distroless/cc`) with `kubectl` 1.37.1. `kubectl` uses the API's in-cluster ServiceAccount (`KUBERNETES_SERVICE_HOST`/`KUBERNETES_SERVICE_PORT` are passed to the CLI); local cluster only.
- The API's games-namespace Role also grants `pods/exec` (get, create; revised 2026-10-17, maintainer in chat), so `kubectl exec` into game pods works without extra setup; it is no wider than the `pods/attach` the console already holds. The Helm value `api.ai.clusterRole` (empty by default) binds the named ClusterRole (for example `view`, `edit` or `cluster-admin`) to `gameplane-api` (ClusterRoleBinding `<release>-api-ai`); this widens the API pod itself.
- Shell commands bypass the API router: RBAC, approvals, server pinning and the Gameplane audit log do not apply to them. They are kept in `ai_messages` with the rest of the conversation. The shell can read the API's data volume and every Secret the ServiceAccount can read, including the Claude credential (`gameplane-ai`), backup destination and auth-provider Secrets. This is the admin `Bash` tool only; the per-server `shell` tool below goes through the router.

### Server shell and archive tools

- `shell` (all paths, every user): runs `sh -c <command>` through `POST /servers/{name}/shell` (`api/internal/ws/exec.go`) in the server's `game` container with the working directory set to the `data` volume mount (`/data` by default). The route goes through the router like `files/write`, so it needs `servers:write` (owners and collaborators included), stays pinned to the conversation's server, and works on any cluster the API has kube credentials for (gateway-only clusters return 503). Body `{command, timeoutSeconds}`: command at most 8 KiB, timeout 30 s by default and at most 55 s (exit code 124 on timeout); stdout and stderr are each cut at 1 MiB and the tool result at 45000 bytes. Each command is written to the audit log (target = first 200 characters). No approval in any mode (maintainer decision 2026-10-26): a user who can write files and install plugins can already run code in that container.
- `read_archive` (all paths): lists a `.jar` or `.zip` on the data volume (non-class files with sizes, plus the `.class` count) or shows one text entry with line numbers. It checks the size through `files/list` (at most 64 MiB), authorizes as `files/read` and downloads through `files/download`; an entry is read up to 2 MiB. The system prompt keeps it, and `unzip` through `shell`, as a last resort for checking supported settings.

### Linear

- Config section `ai` adds `linearEnabled`, `linearComment`, `linearWrite`: the admin turns Linear on and sets what the assistant may change. Each user stores their own Linear API key on the personal Settings → Integrations page (`/settings/integrations`) in a labelled Secret `gameplane-ai-linear-<user id>` (`gameplane.local/ai=true`, key `apiKey`) via `PUT /ai/linear/key {apiKey}` and `DELETE /ai/linear/key`; `GET /ai/linear` returns `{enabled, comment, write, keySet, keyHint}` (`keyHint` = last four characters). Changes made in Linear appear under that user.
- While Linear is enabled and the conversation owner has a key, each run opens an MCP client session to `https://mcp.linear.app/mcp` (streamable HTTP, `Authorization: Bearer <key>`) and offers Linear's tools as `linear_<tool>`: on the API-key path as extra custom tools, in subscription mode through the local `gameplane` MCP endpoint (`mcp__gameplane__linear_<tool>` in `--allowedTools`), so the key never reaches the CLI. A failed connection leaves the run without Linear tools.
- Tools named `get_*`, `list_*`, `search_*`, `extract_*` are reads and always offered; `save_comment` needs `linearComment`; every other tool needs `linearWrite`. Non-read calls follow the approval rule (`awaiting_approval`, pending entry `{method: "LINEAR", path: <tool>}`) except in `bypassPermissions`.
- `GET /ai/status` adds `linear` (enabled and the caller has a key). `GET /ai/linear/issues` returns the 25 most recently updated issues `[{id, title, status, statusType}]` for the mention menu.
- Web: the composer's `@` menu offers "Linear" (inserts `@linear `) and recent issues (`@linear ABC-123 `; typing an issue key after `@linear` filters them). User messages show a Linear card per mention; Linear tool calls show the logo, tool name and main argument.

### Records

- Tables `ai_conversations` (owner, scope, model, effort, status, error, token usage, timestamps) and `ai_messages` (Anthropic message JSON per turn, append-only). Kept when the conversation ends; there is no delete endpoint.
- `ai_conversations.session_id` (migration `021_ai_session.sql`) keeps the Claude Code session for `--resume`. Stream-json `assistant` and `user` events are stored in `ai_messages`, with the MCP tool name rewritten to `gameplane_api`.
- Every tool call is also an ordinary audit event under the user's name.
- Users see their own conversations; holders of `audit:read` can list everyone's (`scope=all`).

### API

- `GET /ai/status` → `{enabled, configured, defaultModel, defaultEffort, defaultMode}`.
- `GET /ai/conversations?server=&namespace=&cluster=` (own, exact scope; empty = general) or `?scope=all`.
- `POST /ai/conversations {prompt, server?, namespace?, cluster?, model?, effort?, mode?}` → 201, run starts in the background.
- `GET /ai/conversations/{id}` → `{conversation, messages, pending}`.
- `POST /ai/conversations/{id}/messages {prompt, mode?}`, `POST …/approval {approve}`, `POST …/cancel`. Only the owner may write; a run in progress → 409.
- RBAC: `/ai` needs any authenticated user; `/admin/ai` needs `config:manage`.
- Admin: config section `ai` `{enabled, defaultModel, defaultEffort, defaultMode, apiKeySet, subscriptionSet?}`; the credential is stored in the labelled Secret `gameplane-ai` (`gameplane.local/ai=true`) as key `apiKey` or, for a subscription token, `oauthToken` via `PUT /admin/ai/secret` (`{apiKey}` or `{oauthToken}`, exactly one; storing one clears the other) and `DELETE /admin/ai/secret`.
- Runs execute in a background goroutine (max 40 model calls per turn); the web polls while a run is active and streams the reply text over `GET /ai/conversations/{id}/stream` (SSE) as it is written. A run interrupted by an API restart is marked `error` at startup.

### Web

- Sidebar "General" → "Assistant" (`/assistant`), shown while the assistant is enabled; conversation history with an admin "All users" toggle.
- Server detail → "Assistant" tab with the same panel scoped to the server.
- Panel: conversation list, transcript (text, tool calls with method/path/status, file tools as `READ|EDIT|WRITE <path>`, shell commands as `BASH <command>`), approval card, stop button, composer with a permission mode picker (the conversation's mode, or the admin default for a new one; a picked mode is sent with the next message; red for Bypass permissions). New conversations use the admin's default model and effort (the API also accepts `model`/`effort` per conversation; the panel has no picker).
- Admin settings → "AI assistant": enable switch, Claude credential (write-only Console API key or `claude setup-token` subscription token), default model, effort and permission mode.

## Out of scope

- Console (RCON/PTY) commands; streaming token output; per-role `ai:use` permission; deleting conversation records.
