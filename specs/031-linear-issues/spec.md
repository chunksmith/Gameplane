# Feature Specification: Linear issues

**Created**: 2026-11-27

**Status**: Draft (design approved, spec awaiting review)

**Input**: Maintainer request (2026-11-27, in chat): Linear support already exists (spec 027). Add an area that lists the existing issues, solves them with the assistant, writes a reply and moves them to Done or In Review. It integrates with repository builds (spec 030), so the assistant can build and deploy. Design in Figma first.

**Depends on**: spec 027 (assistant, Linear MCP, per-user Linear keys), spec 029 (repositories), spec 030 (builds, `build_*` tools, `AssistantPanel` `seed`). Spec 030 must be merged first.

## Clarifications

### Session 2026-11-27 (maintainer, in chat)

- Q: Where does it live? → A: A new sidebar page **Linear** (`/linear`) under General, after Assistant. Settled.
- Q: Which lists? → A: Tabs **My issues**, **Team**, **All issues** (Team shows one team, so All issues covers the whole workspace), **In review**, **Assistant runs**, **Repository links**. Settled.
- Q: How does solving start? → A: The issue's **Solve with Assistant** card has only a **Repository** select and a **First message** (prefilled `Solve CHK-142.`), then **Start solving**. No build, deploy, reply or status options up front. Settled.
- Q: What happens after the fix? → A: The assistant **asks** in the chat ("Fixed, build #16 passed. Deploy to spawn-1, spawn-2, overworld, reply on CHK-142 and move it to In Review?"). The user answers in the chat. Settled.
- Q: Single message or conversation? → A: A **normal multi-message assistant conversation** with a composer, embedded in the issue detail. Settled.
- Q: Status on start? → A: **Start solving moves the issue to In Progress** at once; the click counts as approval. The reply and the move to In Review or Done always need approval in the chat. Settled.
- Design: built in Figma through figma-mcp-go and approved by the maintainer on 2026-11-27 (core rule 1). File "Gameplane Dashboard", page "Page 1":
  - Linear / Issues / Desktop / Dark (`105:2511`)
  - Linear / Issue / Solving / Desktop / Dark (`105:2873`)
  - Linear / Issues / Mobile / Dark (`105:3278`) and Light (`105:3388`)

## Design

### Screens

1. **Page header**: Linear logo, `Linear`, workspace pill, `signed in as @user · team <Team> (<KEY>) · synced <age>`, **Refresh**, **Open Linear ↗**.
2. **Toolbar**: Team select, Status multi-select (default Todo, In Progress, In Review), Sort (Priority, Updated), refresh, **Search issues**.
3. **Left: issue list**, header `Issues · N` and the tab's scope (`Assigned to you`). Each row:
   - status dot (Todo/Backlog grey, In Progress amber, In Review accent, Done green);
   - `KEY · title`; `Status · Priority · project` plus the assistant state (`Assistant solving`, `replied by Assistant`, `build #14`, `deployed by Assistant`);
   - right: priority (`P1`…`P4`) or, while solving, the elapsed time; age.
4. **Right: issue detail**:
   - Header: `KEY · title`, `Status · Priority · labels · project · opened by @x <age> · assigned to you`, **Open in Linear ↗**.
   - **Description** and **Comments · N** cards (read-only; replies are posted by the assistant after approval).
   - **Solve with Assistant** card: Repository select (`⑂ LitHomes · main · clean`, hint `Linked from project LitHomes · change in Repository links`), First message textarea, the note "Moves KEY to In Progress. The Assistant asks before it builds, deploys, pushes, replies or changes the status.", **Start solving**. Hidden while Linear is unavailable to the user (no key or disabled), with a link to Settings → Integrations.
5. **Solving** (frame `105:2873`): Description and Comments collapse; the card becomes the embedded assistant conversation (`ASSISTANT · <REPO> · RUNNING m:ss`, **Open in Assistant tab ↗**, **Stop**), the thread (seed message with the Linear issue attachment, tool rows, assistant questions, user replies, approval cards with a reply preview) and the composer pinned at the bottom. The list row shows `In Progress · Assistant solving` with a timer.
6. **Assistant runs** tab: issues with a linked conversation, newest first, with conversation state.
7. **Repository links** tab: a table of Linear projects → repository; used to preselect the Repository select.
8. **Mobile**: list and a compact Solve card; tapping an issue opens it full-width with `← Issues`; Start solving opens the same chat with the composer pinned at the bottom. Tabs scroll horizontally.

## Architecture

### API (UX gateway, core rule 10)

All calls run with the caller's own Linear key through the existing MCP session (`openLinear` in `api/internal/handlers/ai_linear.go`); no new Linear credentials. Errors from Linear map to 502, missing key or disabled Linear to 503 (existing `linearIssues` behaviour).

- `GET /ai/linear/teams` → `[{id, key, name}]` (`list_teams`).
- `GET /ai/linear/issues?view=mine|team|all|review|runs&team=&status=&q=&sort=&cursor=` → `{issues: [{id, identifier, title, status, statusType, priority, project, assignee, updatedAt, url, run?}], cursor}` (`list_issues`, `search_issues` for `q`). `run` joins the linked conversation (below). The existing `GET /ai/linear/issues` (mention menu) keeps its shape.
- `GET /ai/linear/issues/{id}` → issue detail with description and comments (`get_issue`, `list_comments`).
- `POST /ai/linear/issues/{id}/solve {repository, message}`:
  1. checks the caller may use the repository's assistant (same RBAC as creating a repository-scope conversation);
  2. moves the issue to the team's first `started` state (`list_issue_statuses` + `save_issue`), allowed without `linearWrite` because the user clicked;
  3. creates a repository-scope conversation whose first message is `message` plus `@linear <KEY>`, and links it to the issue;
  4. returns `{conversation}`.
- `GET|PUT /ai/linear/links` → `[{projectId, projectName, repository}]`, per user.
- Audit: `linear.solve.start` with issue and repository.

### Database

Migration `api/internal/db/migrations/common/027_linear.sql` (portable SQL, values bound from Go):

- `ALTER TABLE ai_conversations ADD COLUMN linear_issue TEXT NOT NULL DEFAULT ''` (issue identifier) plus an index on `(user_id, linear_issue)`.
- `CREATE TABLE linear_repo_links (user_id BIGINT NOT NULL, project_id TEXT NOT NULL, project_name TEXT NOT NULL, repository TEXT NOT NULL, PRIMARY KEY (user_id, project_id))`.

### Assistant

- A conversation with `linear_issue` set adds to the system prompt: "You are solving Linear issue KEY in this repository. Fix it, then build with `build_start`. Then stop and ask the user what to do next: deploy (name the servers that run this plugin), reply on KEY and move it to In Review or Done. Never deploy, push, reply or change the status unless the user said so in this conversation."
- No new tools: `linear_save_comment` and `linear_save_issue` (existing, approval-gated, need `linearComment`/`linearWrite`), `build_start`, `build_deploy` (spec 030), Git tools (spec 029).
- The approval card for `linear_save_comment` shows the comment body as a **reply preview** (`REPLY ON KEY · as @user`); a `save_comment` + `save_issue` pair proposed in one turn renders as one card ("Reply and move KEY → In Review").
- If `linearComment` or `linearWrite` is off, the prompt tells the assistant it cannot reply or move, so it says so instead of asking.

### Web

- `web/src/routes/Linear.tsx` (+ `Linear.test.tsx`), registered at `/linear` in `web/src/router/tree.tsx`; sidebar entry with `LinearLogo` in `AppLayout.tsx`, shown when `GET /ai/status` reports `linear`.
- Components in `web/src/components/linear/`: `IssueList`, `IssueDetail`, `SolveCard`, `RepositoryLinks`.
- The solving view embeds `AssistantPanel` with `scope={{ repository }}` and the linked conversation selected (no new chat UI).
- Client in `web/src/lib/linear.ts`, types in `web/src/types.ts`; tool-row labels and the reply-preview card in `web/src/lib/assistant.ts` / assistant components.
- Strings per spec 019 (`web.linear.*`); HeroUI v3 and `globals.css` tokens only.

## Security

- Everything runs as the caller with their own Linear key and RBAC; Linear text is data, never instructions (existing prompt rule).
- The only write without an in-chat approval is the move to In Progress on Start solving, and it is the user's click.
- Deploys stay approval-gated in every mode except `bypassPermissions` (spec 030).

## Out of scope (v1)

- Creating or editing issues from the panel (beyond the reply and status change).
- Webhooks or live sync from Linear; the list refreshes on demand and every 60 s while visible.
- Solving several issues in one conversation.
