# Feature Specification: Repositories

**Feature Branch**: `feat/repositories`

**Created**: 2026-10-27

**Status**: Draft (design approved, spec awaiting review)

**Input**: Maintainer request (2026-10-27, in chat): an area in the panel to manage Git repositories, for example `https://github.com/chunksmith/lfln-bettermodel`. Authorized people add, remove and edit files there, with the same file and assistant systems the servers have. An extra Git area runs pull, fetch, push, commit and similar. Everyone works with their own token. Network support works as it does for servers. Design in Figma first, code after approval.

## Clarifications

### Session 2026-10-27 (maintainer, in chat)

- Q: One working copy per repository, or one per user? → A: **One shared working copy** per repository on a volume. Everyone with access sees the same uncommitted changes, like a server's files. Settled.
- Q: Where is the GitHub token entered? → A: **Settings → Integrations**, a personal GitHub card next to the Linear card. One token per user, used for every repository, usable only by its owner. Settled.
- Q: Which Git operations? → A: status, diff, stage and unstage, commit, fetch, pull, push; branches (list, switch, create); history (log and commit detail); discard per file and discard all. Settled.
- Q: Who adds repositories and who reaches them? → A: The server model. A role permission adds repositories; each repository has an owner, collaborators and an optional network whose members get access. Settled.
- Q: Git engine? → A: The `git` CLI in a separate non-root `gameplane-repo-agent` image (agent binary plus Git); the distroless game agent stays unchanged. Settled.
- Q: Pull on a diverged branch? → A: Rebase (`git pull --rebase`); a conflict aborts and reports the files. Settled.
- Q: Who may create repositories? → A: `repositories:create` in the built-in `admin` and `operator` roles; others reach repositories only as owner, collaborator or network member. Settled.
- Design: built in Figma through figma-mcp-go and approved by the maintainer on 2026-10-27 (core rule 1). File "Gameplane Dashboard", page "Page 1":
  - Repositories / List / Desktop / Dark (`83:1607`)
  - Repositories / Add repository modal / Desktop / Dark (`83:1846`)
  - Repository / Files / Desktop / Dark / AI split (`83:675`)
  - Repository / Git / Desktop / Dark (`83:1167`)
  - Repository / Git / History / Desktop / Dark (`83:1921`)
  - Repository / Settings / Desktop / Dark (`83:2249`)
  - Repository / Git / Mobile / Dark (`83:2673`) and Light (`83:2923`)
  - Settings / Integrations / GitHub card / Desktop / Dark (`83:1884`)

## Design

### Screens

1. **`/repositories`**, a sidebar item under General, right after Servers.
   - Header: title, subtitle, a GitHub connection chip (`GitHub · @login` or "Connect GitHub" linking to Integrations), search, and **Add repository** (needs `repositories:create`).
   - Cards: initials avatar, name, `owner/repo · branch`, chips for working-tree state (`N changes` or `Clean`), ahead/behind (`↓2 ↑1` or `up to date`), network and visibility, a footer with member count and last fetch, and **Open →**. A repository still cloning shows `Cloning… NN%`.
2. **Add repository** modal: HTTPS URL (github.com only in v1), branch (empty = default branch), name (DNS-1123 label, prefilled from the URL), network (optional select), disk size (default 2 Gi), and a note that the clone runs with the caller's token. Submit is disabled without a connected GitHub token.
3. **`/repositories/$name`** with a header like a server's: avatar, name, branch pill, `github.com/owner/repo · N changes · ↓x ↑y · fetched … · network: …`, **Pull** and **Push** buttons and a `⋯` menu (Fetch, Re-clone, Copy URL). Tabs:
   - **Files**: the server Files tab unchanged (tree and list views, editor tabs, upload, new file and folder, context menu, AI split). Tree rows show the Git status letter (`M`, `U`, `A`, `D`) with the matching colour. `.git` is never listed.
   - **Git** with a `Changes · N | History` toggle, a branch picker (`⑂ main ▾ tracking origin/main · ↓2 ↑1`), the AI button, refresh, **New branch** and **Fetch**.
     - Changes: a left panel with *Staged* (Unstage all) and *Changes* (Discard all · Stage all) lists, then a commit box (summary, optional description, "Commits and pushes use your own GitHub token (@login)", **Commit N files** and **Commit & push**). The right panel shows the selected file's unified diff with **Stage file** or **Unstage file** and **Discard**.
     - History: *Not pushed · N* (Undo last commit) and *origin/branch* (`↓N to pull`) commit lists. The right panel shows the commit's SHA, subject, author, time, file count, **Copy SHA**, **Revert commit** and the commit diff.
   - **Assistant**: the server Assistant tab, scoped to the repository.
   - **Settings**: a repository card (owner, added, disk use, collaborators), **Network** (Change network), **Collaborators** (Read, Edit, Push grants; Add collaborator; Remove) and **Remove this repository** (deletes the working copy, never touches GitHub).
4. **Settings → Integrations → GitHub**: personal access token (masked `github_pat_••••XXXX`, Replace, Remove), signed-in login (Verified), and the token's repository contents and workflows access as read from GitHub.
5. **Mobile**: tabs scroll horizontally; the Git tab stacks the lists and the commit box, and a tapped file opens its diff full width with `← Changes`. Fetch and New branch move to the `⋯` menu.

## Architecture

### Kubernetes (core rule 9, 10)

- New CRD **`Repository`** (`gameplane.local/v1alpha1`, namespaced). Spec: `url`, `branch`, `storage.size`, `storage.storageClassName`. Ownership, collaborators and network use the same annotations as `GameServer` (`gameplane.local/owner-id`, `gameplane.local/owner`, `gameplane.local/collaborators`, `gameplane.local/network`). Status: `phase` (`Pending`, `Cloning`, `Ready`, `Failed`), `head`, `branch`, `ahead`, `behind`, `dirty`, `lastFetch`, `conditions`.
- `RepositoryReconciler` owns a PVC `<repo>-data`, a single-replica StatefulSet `<repo>` running the **repo agent**, a Service `<repo>-agent` on 8090, and the agent mTLS certificate (reusing `agent_certs.go`). The reconciler never runs Git and never holds a user token.
- The repo agent is the existing agent binary started with `--mode=repository --data-root=/repo`. It reuses `files.Mount` with `.git` hidden and blocked and other dotfiles allowed (`.github`, `.gitignore`). A new `agent/internal/git` package serves `/git/*` and runs the `git` CLI from the `gameplane-repo-agent` image; pull uses `--rebase`. One mutex per repository serializes Git commands; a busy repository answers `409 repository_busy`.

### Tokens

- Each user's token is a managed Secret `gameplane-github-<userID>` in the control namespace with key `token`, label `gameplane.local/github-token=true`, written through `upsertLabelledSecret`. It is never returned; reads report `keySet`, `keyHint` (last 4) and the verified `login`.
- For every network operation (clone, fetch, pull, push), the API reads the **acting user's** Secret and passes it to the repo agent in the `X-Gameplane-Git-Token` header over the mTLS channel. The agent hands it to Git through `GIT_ASKPASS` for that one command, never writes it to disk or to `.git/config`, and redacts it from output. A missing token answers `428 github_token_required`.
- Commits use the acting user's GitHub name and `<id>+<login>@users.noreply.github.com`, read from `GET https://api.github.com/user` when the token is saved.
- Remote URLs are HTTPS on `github.com` only in v1; the agent dials through `netguard.IsPublic`.

### API

- `/repositories` CRUD, `/repositories/{name}/access`, collaborators and network, `/repositories/{name}/files/*` (the server file proxy, routed to `<repo>-agent`) and `/repositories/{name}/git/*`. See [contracts/repositories-api.md](contracts/repositories-api.md).
- Permissions: `repositories:read`, `repositories:write`, `repositories:push`, `repositories:create`, `repositories:manage` in `rbac/catalog.go`. The owner, collaborator and network fallback mirrors servers: owner has all, collaborators and network members get the grants on their membership (`read`, `edit` = `repositories:write`, `push` = `repositories:push`). `repositories:manage` (admin) reaches every repository.
- Every Git write (commit, push, pull, discard, branch create or switch, revert, reset) and every file write is audited with the actor.
- Home cluster only in v1: a remote `?cluster=` answers 501 (OPEN-DECISIONS 1).
- **Live state (decided 2026-10-27, Phase 3).** The API reads the agent's token-free `GET /git/clone` and `GET /git/status` on each list and detail read and derives `phase` (`Cloning`, `Failed`, `Ready`), clone progress, `head`, `branch`, `ahead`, `behind` and the change count from them. The reconciler does not poll the agent: its agent client only quiesces and stops game servers, and a status copy would lag every local Git operation; the operator keeps writing `phase: Pending` and `AgentReady` only. `lastFetch` and `storage.used` stay `null` until the agent reports them.
- **First clone (decided 2026-10-27, Phase 3).** The agent is not ready when `POST /repositories` returns, so the API starts the clone the first time the owner reads the repository while the agent is ready, idle and has no working copy, with the owner's token. A failed clone is retried with `:reclone`.
- **Collaborator grants** live on the CR: `gameplane.local/collaborators` and `collaborator-names` as for servers, plus `gameplane.local/collaborator-permissions`, a JSON map of user ID to the grants beyond read (`repositories:write`, `repositories:push`). Network memberships may grant `repositories:write` and `repositories:push`.

### Assistant

- `ai_conversations` gets a `repository` column (new common migration). A repository-scoped conversation may call only `/repositories/{repo}/files/*` and `/repositories/{repo}/git/*`.
- File tools (`read_file`, `edit_file`, `write_file`) target the repository. New tools `git_status`, `git_diff`, `git_log`, `git_commit` and `git_push`. `git_push`, `git_pull`, discard, reset and revert always need approval, in every permission mode except `bypassPermissions`. There is no `shell` tool in repository scope.
- Assistant Git calls run with the user's own token, as their dashboard calls do.

### Web

- Routes `web/src/routes/Repositories.tsx`, `web/src/routes/RepositoryDetail.tsx` with tabs under `web/src/routes/repository/`. The Files and Assistant tabs reuse the server components through a target abstraction (`/servers/{name}` or `/repositories/{name}` base path) instead of copies.
- Strings follow spec 019 (`web.repositories.*`), tokens from `globals.css`, HeroUI v3 components, lucide icons (`FolderGit2`, `GitBranch`, `GitCommitHorizontal`, `Github`).

## Out of scope (v1)

GitHub Apps or OAuth sign-in, Git hosts other than github.com, SSH remotes, per-user working copies, merge-conflict resolution in the UI (a conflicted pull aborts and reports the files), pull requests, LFS, submodules, and remote clusters.
