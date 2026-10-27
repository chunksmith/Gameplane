# Contract: Repositories API

JSON over the existing session cookie and CSRF rules. All routes are **home-cluster only**: a `?cluster=` naming another registered cluster answers `501`. `{name}` is a DNS-1123 label; `?namespace=` defaults like servers.

Errors use ids registered in `api/internal/messages` as `server.repositories.*` (the registry and `make i18n-sync` take only `server.*` ids; `repositories.<code>` below is shorthand). Every `/git/*` error, and the `.git` refusal on `/files/*`, is an `application/problem+json` document with the extension members `code` (the agent's code: `busy`, `dirty`, `conflict`, `push_rejected`, `already_pushed`, `not_empty`, `git_dir`, `bad_request`, `remote_not_allowed`, `too_large`, `git_failed`, `not_found`, `internal`, `github_token_required`), `output` (redacted Git stderr, optional), `files` (conflicted paths, optional) and `commit` (the local commit when `commit` with `push` was rejected, optional):

```json
{ "type": "about:blank", "status": 409, "title": "Conflict", "detail": "The changes conflict and were not applied.",
  "messageId": "server.repositories.conflict", "args": {}, "code": "conflict", "files": ["a.txt"], "output": "CONFLICT (content): …" }
```

Other `/files/*` errors pass through from the agent unchanged, as for servers.

```ts
type RepoPhase = "Pending" | "Cloning" | "Ready" | "Failed";
type FileState = "M" | "A" | "D" | "R" | "U";   // U = untracked

interface Repository {
  name: string; namespace: string; uid: string;
  url: string; branch: string; network: string;
  owner: { id: string; name: string }; collaborators: number;
  phase: RepoPhase; cloneProgress: number | null; // 0-100 while Cloning
  error: string | null;                           // clone failure message while Failed
  head: string | null; ahead: number; behind: number; changes: number;
  lastFetch: string | null;                       // RFC 3339; always null in v1 (the agent does not report it yet)
  storage: { size: string; used: number | null }; // used in bytes; always null in v1
}
interface Change { path: string; oldPath?: string; state: FileState; staged: boolean; additions: number; deletions: number }
interface Commit { sha: string; subject: string; body: string; author: string; login: string | null; time: string; pushed: boolean }
interface Branch { name: string; current: boolean; upstream: string | null; ahead: number; behind: number }
```

## Repositories

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/repositories` | `repositories:read` or membership | Filtered to what the caller may read |
| POST | `/repositories` | `repositories:create` + GitHub token | `{url, branch?, name, network?, storageSize?}` → 201 `Repository` (phase `Pending`). `?namespace=` picks the namespace. The name may not be taken by a GameServer (409 `name_taken`). Without a token 428 `github_token_required` |
| GET | `/repositories/{name}` | read | `Repository` |
| DELETE | `/repositories/{name}` | owner or `repositories:manage` | 204; deletes the CR, the PVC goes with it |
| GET | `/repositories/{name}/access` | read | `{isOwner, isCollaborator, permissions: string[]}`; `permissions` ⊆ `repositories:read`, `:write`, `:push`, `:manage` (`:manage` = owner-only operations allowed) |
| PUT | `/repositories/{name}:network` | owner | `{network}`; empty clears; 204 |
| GET | `/repositories/{name}/collaborators` | read | `{userId, username, read: true, edit, push}[]` |
| POST | `/repositories/{name}/collaborators` | owner | `{username, edit, push}` adds or updates by username, resolved server-side like server collaborators (non-admin owners cannot list users); 204; unknown user 404 `server.common.user_not_found` |
| PUT/DELETE | `/repositories/{name}/collaborators/{userId}` | owner | PUT body `{edit, push}` (read is implied); 204 |
| POST | `/repositories/{name}:reclone` | owner + token | 202 `Repository`; wipes the working copy and clones again with the caller's token |

**Clone start.** The agent pod is not up when `POST /repositories` returns, so the API starts the first clone lazily: when the **owner** reads the repository (list or detail) and the agent reports no working copy and no running clone, the API calls the agent's `POST /git/clone` with the owner's token. The dashboard polls the repository while it is `Pending` or `Cloning`, so the clone starts within one poll of the agent becoming ready.

**Live state.** `phase`, `cloneProgress`, `error`, `head`, `branch`, `ahead`, `behind` and `changes` are read live from the agent's token-free `GET /git/clone` and `GET /git/status` on every list and detail read (5 s timeout; an unreachable agent leaves the CR phase, `Pending`): clone `running` → `Cloning`, `failed` → `Failed`, a Git status → `Ready`, otherwise `Pending`. The CR status keeps only what the operator writes (`phase: Pending`, `AgentReady`).

## GitHub token routes

`PUT /integrations/github/token` → 200 with the `GET` body below. `contents`/`workflows` are read from a classic token's `X-OAuth-Scopes` (`repo`/`public_repo` → `"write"`, else `"none"`; `workflow`); a fine-grained token reports `null` for both (OPEN-DECISIONS 2).

## Files

`/repositories/{name}/files/{list,size,read,download,archive,write,create,upload,mkdir,zip,delete}` — the server file proxy contract unchanged, read routes need read, write routes need `repositories:write`. Paths with any `.git` component answer `403 repositories.git_dir`.

## Git

Read routes need read; the rest need `repositories:write`; `push`, and `commit` with `push: true`, need `repositories:push`. Routes marked **net** need the caller's token (`428 repositories.github_token_required`); `commit` and `revert` need it too, for the author identity (`<name> <<id>+<login>@users.noreply.github.com>`). The API adds `X-Gameplane-Git-Token` only to `fetch`, `pull`, `push` and `commit` with `push: true`, and the author headers only to `commit`, `revert` and `pull`; browser-supplied values of these headers are dropped.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/git/status` | | `{branch, head: string \| null, upstream: string \| null, ahead, behind, changes: Change[]}` |
| GET | `/git/diff` | `?path=&staged=` | `text/x-diff` (5 MiB cap, `413` beyond); empty for untracked files (read the file instead) |
| POST | `/git/stage` | `{paths: string[] \| "all"}` | status |
| POST | `/git/unstage` | `{paths \| "all"}` | status |
| POST | `/git/discard` | `{paths \| "all"}` | status |
| POST | `/git/commit` | `{summary, description?, push?: boolean}` | `{commit: Commit, pushed: boolean}` |
| GET | `/git/log` | `?ref=&limit=50&cursor=` | `{commits: Commit[], next: string \| null}` |
| GET | `/git/commits/{sha}` | | `{commit: Commit, diff: string}` |
| POST | `/git/revert` | `{sha}` | `{commit}` |
| POST | `/git/undo` | | status; resets the last unpushed commit, keeping its changes staged; `409 repositories.already_pushed` for a pushed commit |
| GET | `/git/branches` | | `Branch[]` (local and remote) |
| POST | `/git/branches` | `{name, from?}` | `Branch` |
| POST | `/git/checkout` | `{branch}` | status; `409 repositories.dirty` with uncommitted changes |
| POST | `/git/fetch` **net** | | status |
| POST | `/git/pull` **net** | | status; conflicts abort, `409 repositories.conflict` with `files` |
| POST | `/git/push` **net** | `{setUpstream?: boolean}` | status; rejected non-fast-forward → `409 repositories.push_rejected` |

Agent-only (not proxied; the API calls them): `POST /git/clone {url, branch?, wipe?}` + token → 202 `{state: "running"}`, `409 repositories.not_empty` without `wipe`; `GET /git/clone` → `{state: "idle" | "running" | "done" | "failed", progress: 0-100, error?: {code, message}}`.

Busy repository (another Git command running): `409 repositories.busy`.

## GitHub token

| Method | Path | Response |
|---|---|---|
| GET | `/integrations/github` | `{keySet, keyHint, login, name, contents: "write" \| "read" \| "none" \| null, workflows: boolean \| null}` |
| PUT | `/integrations/github/token` | `{token}` → verifies against `api.github.com/user`; `422 repositories.token_invalid` on failure |
| DELETE | `/integrations/github/token` | 204 |
