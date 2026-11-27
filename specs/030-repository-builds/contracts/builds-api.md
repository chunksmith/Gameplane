# Contract: Repository builds API

## Conventions

These routes follow [spec 029's conventions](../../029-repositories/contracts/repositories-api.md):
- JSON over the session cookie and CSRF rules.
- Home cluster only: a remote `?cluster=` answers 501.
- `?namespace=` works as for servers.
- Errors are `application/problem+json` with ids `server.repositories.builds.*` registered in `api/internal/messages`. `builds.<code>` below is shorthand.

"read", "write" and "push" mean the caller's effective `repositories:*` grant on that repository: role, owner, collaborator or network, as in spec 029.

## Types

```ts
type BuildPhase = "Queued" | "Pending" | "Running" | "Succeeded" | "Failed";
type BuildTool = "auto" | "maven" | "gradle";

interface BuildSettings { tool: BuildTool; detected: "maven" | "gradle" | null; jdk: 17 | 21 | 25; args: string; publish: boolean }

interface Artifact { path: string; name: string; size: number; sha256: string; shaded: boolean }

interface Build {
  number: number; name: string; repository: string;
  phase: BuildPhase; message: string | null;
  tool: "maven" | "gradle"; jdk: number; args: string; publish: boolean; published: boolean | null; // null until finished or when publish is off
  source: { commit: string | null; changes: number };
  startedBy: { id: string; name: string } | null; via: "dashboard" | "assistant";
  createdAt: string; startTime: string | null; completionTime: string | null;
  limits: { cpu: string; memory: string };
  artifacts: Artifact[];
  deployments: Deployment[];   // data-model.md
}

interface DeployTarget { cluster?: string; namespace?: string; server: string }
interface DeployRequest {
  artifact: string;            // Artifact.path
  targets: DeployTarget[];     // 1..50, no duplicates
  dir?: string;                // default "plugins"; relative, no "..", no leading "/"
  filename?: string;           // default basename(artifact); must end in .jar, no "/"
  remove?: string[];           // file names in dir; must end in .jar; never equal to filename
  restart?: boolean;           // default false
}
interface DeployResult { deployment: Deployment }
```

## Builds

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/repositories/{name}/builds` | read | `{ builds: Build[], settings: BuildSettings, cacheBytes: number \| null, keep: number }`, newest first |
| POST | `/repositories/{name}/builds` | write | Body `{tool?, jdk?, args?}`. Unset fields come from `spec.build`; `publish` always comes from the repository settings. Answers 201 `Build` (`Queued` or `Pending`). Errors: 409 `builds.active` when a build is `Queued`, `Pending` or `Running`; 409 `builds.not_ready` when the repository is not `Ready`; 422 `builds.no_project` when auto finds neither `pom.xml` nor `build.gradle(.kts)` |
| GET | `/repositories/{name}/builds/{number}` | read | `Build` |
| DELETE | `/repositories/{name}/builds/{number}` | write | 204. Cancels a running build and deletes a finished one. Audited `repository.build.delete` |
| GET | `/repositories/{name}/builds/{number}/log` | read | `text/plain` pod log. `?follow=1` streams until the pod ends. 404 `builds.log_gone` when the pod no longer exists |
| POST | `/repositories/{name}/builds:clear-cache` | write | 202. Sets the `gameplane.local/clear-cache` annotation. 409 `builds.active` while a build is active. Audited |
| PUT | `/repositories/{name}/build` | write | Body `BuildSettings` without `detected`; answers `BuildSettings`. Audited `repository.build.settings` |

`POST /builds` is audited as `repository.build.start` with `{number, via}`. `via` is `assistant` when an assistant tool call makes the request.

## Deploy

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/repositories/{name}/builds/{number}/deploy` | read on the repository, and `servers:write` on every target | Body `DeployRequest`; answers 200 `DeployResult` |

Validation happens before anything is written:

| Status | Code | When |
|---|---|---|
| 409 | `builds.not_succeeded` | The build is not `Succeeded`. |
| 404 | `builds.artifact_unknown` | `artifact` is not in `status.artifacts`. |
| 409 | `builds.artifact_changed` | The jar's SHA-256 no longer matches, because a later build overwrote it. |
| 422 | `builds.bad_target` | A target is malformed or listed twice. |
| 403 | `builds.target_forbidden` | The caller lacks `servers:write` on a target. Nothing is written. |
| 422 | `builds.bad_path` | `dir`, `filename` or `remove` is invalid. |

Execution:
- Targets are written in parallel, at most 4 at a time.
- Each target gets these steps, in order, each through the router with the caller's identity:
  1. upload `dir/filename`;
  2. delete each `remove` entry (a missing file is fine);
  3. restart, when `restart` is true.
- A failed step stops that target only. Its error goes into `targets[i].error`.
- The response is 200 even when some targets failed. The web shows `N / M written`.
- Each deployment is audited as `repository.build.deploy`, with the targets and their results. It is appended to the build's `gameplane.local/deployments` annotation.

## Integrations

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/integrations/maven` | any signed-in user | `{ enabled: boolean, url: string \| null, state: "running" \| "unavailable" \| "disabled", artifacts: number \| null, bytes: number \| null, adminUrl: string \| null }`. `url` is the external ingress URL, or `null` without an ingress. Counts come from Reposilite with the read token and are `null` if it does not answer. |

## Assistant tools

The tools call the routes above with the user's own identity, through the `call` replay.

| Tool | Scope | Approval | Route |
|---|---|---|---|
| `builds_list` | repository | no | `GET /builds` |
| `build_start` | repository | no; blocked in plan mode | `POST /builds` |
| `build_status` | repository | no | `GET /builds/{n}` |
| `build_log` | repository | no | `GET /builds/{n}/log` (last 200 lines) |
| `build_deploy` | repository | yes in every mode except `bypassPermissions`; blocked in plan mode | `POST /builds/{n}/deploy` |
| `repositories_list` | all | no | `GET /repositories` |
| `read_file`, `list_files` with `server` or `repository` | all | no | `GET /servers/{s}/files/{list,read,size}` or `GET /repositories/{r}/files/{list,read,size}` |
| `git_status`, `git_log`, `git_diff` with `repository` | all | no | `GET /repositories/{r}/git/{status,log,diff,commits}` |

`authorize` refuses any non-GET call outside the conversation's own target, except `build_deploy`.
