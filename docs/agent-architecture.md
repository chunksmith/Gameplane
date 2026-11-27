# Agent Architecture Index

This document is the **first stop** for AI agents modifying or extending Gameplane. Instead of performing expensive repository-wide greps, use this index to find the component responsible for the feature you are working on, and read the documentation or resource at the path listed in the table (e.g., its corresponding `specs.md`).

## Core Backend Components

| Component | `specs.md` location | Primary Responsibilities |
| --- | --- | --- |
| **API Gateway** | `api/specs.md` | REST/WebSocket gateway, Auth (Local/OIDC), RBAC, DB interactions (SQLite/Postgres), Audit logging, Multi-cluster routing. **Edits to endpoints, auth, or roles go here.** |
| **Operator** | `operator/specs.md` | K8s Controller reconciling CRDs (GameServer, GameTemplate, Backup, Module, etc.). **Edits to Kubernetes resource management, CRD behavior, and K8s API integrations go here.** |
| **Agent Sidecar** | `agent/specs.md` | In-pod sidecar handling RCON, file ops, game server logs, and pod telemetry. **Edits to how the game is interacted with directly (console/files) go here.** |

## Feature Map: Repositories (spec 029)

| Layer | Files | Notes |
| --- | --- | --- |
| **Spec & contract** | `specs/029-repositories/` (`spec.md`, `contracts/repositories-api.md`, `tasks.md`) | Source of truth for routes, permissions and error codes. |
| **Operator** | `operator/api/v1alpha1/repository_types.go`, `operator/internal/controller/repository_controller.go` | `Repository` CRD → PVC, repo agent StatefulSet, Service, agent cert; `--repo-agent-image`. See `operator/specs.md`. |
| **Repo agent** | `agent/internal/git/`, `agent/internal/files/` (repository mode), `agent/cmd/main.go` (`--mode=repository`), `agent/Dockerfile.repo` | `/git/*` over the `git` CLI, `GIT_ASKPASS` token, redaction, `.git` blocked. See `agent/specs.md`. |
| **API** | `api/internal/handlers/repositories.go`, `integrations_github.go`, `ai_git.go`; `api/internal/ws/repository.go`; `api/internal/rbac/repository.go`; `api/internal/messages/entries_repositories.go`; migration `common/025_repositories.sql` | CRUD, collaborators, token Secret, agent proxy, owner/collaborator/network access, assistant Git tools. See `api/specs.md`. |
| **Web** | `web/src/routes/Repositories.tsx`, `RepositoryDetail.tsx`, `repository/`; `web/src/lib/repositories.ts`, `resourceTarget.tsx`; `web/src/components/settings/GitHubCard.tsx` | List, detail tabs, Git tab, Settings, GitHub card. See `web/specs.md`. |
| **Chart & images** | `charts/gameplane/values.yaml` (`repositories.agentImage`), `templates/networkpolicies.yaml`, `repo-agent` image in the publish workflows and `hack/ci_scope.py` | |
| **Security** | `docs/security.md` → Repositories and GitHub tokens | Token storage, transport, redaction, remote allowlist. |
| **E2E** | `test/e2e/api_repositories_e2e_test.go` (bucket `multicluster`) | Clone, edit, commit and push against an in-cluster `git daemon` fixture. |

## Feature Map: Repository builds (spec 030, in progress)

| Layer | Files | Notes |
| --- | --- | --- |
| **Spec & contract** | `specs/030-repository-builds/` (`spec.md`, `data-model.md`, `contracts/builds-api.md`, `tasks.md`) | Source of truth for the build Job, the deploy flow, the assistant rules and the Maven repository. |
| **Operator** | `operator/api/v1alpha1/repositorybuild_types.go`, `operator/internal/controller/repositorybuild_controller.go`; `repository_controller.go` (build cache PVC) | `RepositoryBuild` → sandboxed Maven/Gradle Job pinned next to `<repo>-0`; status from `::artifact::` log markers. |
| **API** | `api/internal/handlers/repository_builds.go`, `ai_builds.go` | Builds, log stream, deploy replay per target, `GET /integrations/maven`, assistant build and deploy tools, cross-target reads. |
| **Web** | `web/src/routes/repository/BuildsTab.tsx`, `DeployModal.tsx`; `web/src/components/ServerPicker.tsx`, `settings/MavenCard.tsx` | Builds tab, Deploy modal (Manual / With Assistant), Build settings card, Maven card. |
| **Chart** | `charts/gameplane/templates/maven.yaml`, `values.yaml` (`mavenRepository`, `repositories.build`), `templates/networkpolicies.yaml` | Reposilite with read and write token Secrets; build egress. |

## Security & Protection Components

| Component | `specs.md` location | Primary Responsibilities |
| --- | --- | --- |
| **Netguard** | `netguard/specs.md` | SSRF dial-guard preventing malicious outbound HTTP requests (e.g., stopping metadata server access during mod downloads). |
| **Gameaction** | `gameaction/specs.md` | Validates and sanitizes RCON inputs/admin commands before they hit the game server to prevent command injection. |
| **Gameproto** | `gameproto/specs.md` | Wire-protocol parsing (Minecraft/Terraria) to safely handle ping handshakes without corrupting game server connections. |

## Feature Add-ons & Sidecars

| Component | `specs.md` location | Primary Responsibilities |
| --- | --- | --- |
| **Capture Sidecar** | `capture-sidecar/specs.md` | Ephemeral network packet capture sidecar injected into game pods to capture traffic. |
| **Sentinel** | `sentinel/specs.md` | Wake-on-connect daemon holding ports for sleeping servers and waking them up upon player connection attempts. |
| **Tunnel** | `tunnel/specs.md` | Relay client supervisor for integrating with external tunnels (frp, Tailscale, playit). |
| **Audit-Syslog-Bridge** | `audit-syslog-bridge/specs.md` | Relay forwarding HTTP JSON audit events to external syslog servers. |
| **Telemetry-Receiver** | `telemetry-receiver/specs.md` | Ingests and processes anonymous usage telemetry from the API. |
| **Telemetryschema** | `telemetryschema/specs.md` | Shared telemetry report contract (types, enumerations, strict decode, official module catalog, report signing) used by the API and the telemetry-receiver. |
| **MCP-Server** | `mcp-server/specs.md` | Read-only Model Context Protocol server exposing cluster state to AI tools. |
| **Svcutil** | `svcutil/specs.md` | Shared stdlib-only env and graceful-shutdown helpers used by backend components. |

## Frontend & Other

| Component | `specs.md` location | Primary Responsibilities |
| --- | --- | --- |
| **Web Dashboard** | `web/specs.md` | The React SPA frontend. |
| **Images** | `docs/img/` | Screenshot gallery for documentation and testing. |
| **Website** | `website/` (submodule) | Public marketing and documentation site. |
| **Modules** | `modules/<game>/specs.md` | OCI bundle templates for deploying specific games (e.g., Minecraft, Rust). |
| **Test e2e** | `test/e2e/specs.md` | E2E integration test suite covering operator and API flows. |

## How to use this index
1. Identify the domain of your task (e.g., "Add an auth provider").
2. Find the component handling this domain (e.g., "API Gateway").
3. Read the documentation or resource at the path listed in the table (e.g., `api/specs.md`) to understand its architecture, boundaries, and specific rules before modifying code.