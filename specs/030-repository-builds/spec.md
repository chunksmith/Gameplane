# Feature Specification: Repository builds

**Created**: 2026-11-27

**Status**: Draft (design approved, spec awaiting review)

**Input**: Maintainer request (2026-11-27, in chat): Java (Paper) plugins live in repositories (spec 029) and must build in the panel.
- Builds run in the cluster from the repository page.
- A built jar goes to one or many chosen servers, by hand or through the assistant.
- The assistant may build and deploy. It may also read other servers and repositories for context.
- Maven and Gradle caches persist, so a build is not cold every time.
- A private Maven repository works like a remote `~/.m2`: panel builds read from it, and the maintainer publishes their own jars to it from a laptop.
- Design in Figma first, code after approval.

## Clarifications

### Session 2026-11-27 (maintainer, in chat)

- Q: Where do builds run? → A: **In the cluster**, as a Job next to the repository's working copy. Uncommitted changes are built. Builds on a player's machine and external CI runners are out of scope. Settled.
- Q: Sizing? → A: Measured on LitHomes (Maven, shade, Java 21) on chunksmith node 9900x-3:
  - Warm cache: ~8.5 core-seconds, so ~4.5 s on 2 CPU. More than 4 CPU gains nothing.
  - Cold cache: ~20–25 s, network-bound (~120 MB downloaded).
  - RAM 0.5–0.8 GB.
  - Defaults: requests `500m`/`768Mi`, limits `2`/`2Gi`, 30 min deadline; set in the chart. Settled.
- Q: Private Maven repository? → A: **Reposilite** (Apache-2.0) in the chart. It has private `releases` and `snapshots` repositories. Builds read from it with a read-only token. Settled.
- Q: Publish builds to it? → A: **On by default** per repository (Settings → Build). It can be switched off. A failed publish does not fail the build. `releases` allows redeploying the same version, so every build of an unchanged version publishes. Settled.
- Q: Deploy approval? → A: An assistant deploy always asks for approval, in every permission mode except `bypassPermissions`. The assistant never deploys on its own initiative: only when the user names the target servers or uses the deploy modal's **With Assistant** mode. Settled.
- Q: Restart after deploy? → A: Optional, **off by default**. Settled.
- Q: Deploy modes? → A: The Deploy modal has a **Manual / With Assistant** switch at the top. Settled.
- Q: Assistant reach? → A: The assistant may build in repository scope. In every scope it may **read** other servers and repositories the user can read. It writes only to its own target, plus approved deploys. Settled.
- Design: built in Figma through figma-mcp-go and approved by the maintainer on 2026-11-27 (core rule 1). File "Gameplane Dashboard", page "Page 1":
  - Repository / Builds / Desktop / Dark (`104:1273`)
  - Repository / Builds / Deploy modal / Desktop / Dark, Manual mode (`104:1661`)
  - Repository / Builds / Deploy modal / With Assistant / Desktop / Dark (`104:2447`)
  - Repository / Settings / Build / Desktop / Dark (`104:1731`)
  - Settings / Integrations / Maven repository card / Desktop / Dark (`104:2088`)
  - Repository / Builds / Mobile / Dark (`104:2126`) and Light (`104:2289`)
  - Assistant / Thread / Build, deploy, cross-server read / Desktop / Dark (`104:2398`)

## Design

### Screens

1. **Builds tab** on `/repositories/$name`, between Git and Assistant.
   - **Toolbar**:
     - Effective settings (`Maven · JDK 21 · -B clean package`) and cache size.
     - "builds run on this repository's node".
     - Refresh, **Clear cache** and **Build**. The last two need `repositories:write`.
   - **Left: builds list**, with "Keeps the last 10". Each row shows:
     - status dot, `#N · Phase`, and source (`53f95f0 + 2 uncommitted`);
     - who started it (`@user` or `Assistant`), the jar count or a failure hint (`compile error`);
     - duration and age. A running row shows elapsed time.
   - **Right: selected build**:
     - Header: `Build #N · Phase`, then tool, JDK, args, duration, limits and starter; **Rebuild** and, while running, **Cancel**.
     - **Artifacts** card: one row per jar with path, size, the source and a `shaded` tag; **Download** and **Deploy to servers…**.
     - **Deployments** card: targets → `dir/filename`, removed jars, restart, actor and approver, age, and `N / M written` (red on partial failure).
     - **Log** card: console colours, with **Follow**, **Copy** and **Download**.
2. **Deploy modal** with a **Manual / With Assistant** segmented switch.
   - **Manual**:
     - **Artifact**: a select. It lists only jars, never sources, javadoc or unshaded `original-*` jars.
     - **Servers**: a searchable multi-select of servers the user may write. It covers every cluster, with runtime, state and any `<name>-*.jar` already in the folder.
     - **Folder** (default `plugins`, relative to the data folder) and **File name** (default: the artifact's name; an existing file is replaced).
     - **Remove old jars**: chips suggested from matching jars on the selected servers.
     - **Restart after deploy**: a switch, off by default.
     - A "Runs with your permissions" note, then **Deploy to N servers**.
     - Stopped servers are written through their files pod.
   - **With Assistant**:
     - A free-text instruction (e.g. "every Paper server in the survival network, remove the old LitHomes jar").
     - A note that the assistant shows the targets and asks for approval before writing.
     - **Ask Assistant**: opens the repository's Assistant tab with a new conversation seeded with the build, the artifact and the instruction.
3. **Settings → Build** card, under the repository card.
   - **Tool**: `Auto`, `Maven`, `Gradle`. Auto shows what it detected.
   - **Java**: 17, 21, 25.
   - **Arguments**: empty uses the tool default.
   - **Publish to Gameplane Maven**: a switch, on by default.
   - A footer with the cache size and the administrator's limits, then **Save**.
4. **Settings → Integrations → Maven repository** card.
   - A state chip.
   - The repository URL with **Copy**.
   - "Publish from your computer" with **Open Reposilite**.
   - Stored artifacts: count and size.
   - "Used by builds: Automatic".
   - A `settings.xml` and `mvn deploy` snippet.
   - Hidden when `mavenRepository.enabled` is false.
5. **Mobile**: the list and the detail stack, and a tapped build opens full width with `← Builds`. The Deploy modal becomes a full-height sheet.
6. **Assistant thread** (frame `104:2398`):
   - `build_start`, `build_status` and `build_log` render as tool rows.
   - `build_deploy` renders as an approval card listing artifact, targets, folder, removals and restart.
   - Cross-target reads render as `Read spawn-1:plugins/LitHomes/config.yml`.

## Architecture

### Kubernetes (core rules 9, 10)

- **New CRD `RepositoryBuild`** (`gameplane.local/v1alpha1`, namespaced, short name `rbuild`), modelled on `Restore`. Each build is one CR named `<repo>-build-<N>` and owned by its `Repository`. See [data-model.md](data-model.md).
- **`Repository` gains `spec.build`** with the per-repository defaults (`tool`, `jdk`, `args`, `publish`, where `publish` defaults to `true`).
- **`RepositoryReconciler` also owns a PVC `<repo>-build-cache`** (RWO, default 5Gi from the chart). The PVC holds `m2/` (`-Dmaven.repo.local`) and `gradle/` (`GRADLE_USER_HOME`).
  - To clear the cache, the API sets the `gameplane.local/clear-cache` annotation to a timestamp.
  - The reconciler then deletes the PVC and recreates it, once no build is active, and records `status.cacheClearedAt`.
- **`RepositoryBuildReconciler`** runs one Job per build.
  - **Queueing**: at most one active build per repository. A later build stays `Queued` until the earlier one ends. The API also answers 409, so the queue is only a safety net.
  - **Placement**: the working copy volume is RWO, so the Job mounts `<repo>-data` at `/repo` and the cache at `/cache`. It has required `podAffinity` to the repo agent pod:
    - selector `app.kubernetes.io/name=gameplane-repo`, `app.kubernetes.io/instance=<repo>`;
    - `topologyKey: kubernetes.io/hostname`.
  - **Image**:
    - Maven: `--build-maven-image` (default `maven:3-eclipse-temurin-{jdk}`).
    - Gradle: `--build-gradle-image` (default `gradle:jdk{jdk}`).
    - `{jdk}` is replaced with the JDK version.
    - A project with `gradlew` uses its wrapper.
    - Images are pinned in chart values by tag. Digests are left to the release process.
  - **Script**: the operator renders the build script and the tool configuration into a Secret `<build>`, owned by the build:
    - a Maven `settings.xml` with an `activeByDefault` profile that adds the Gameplane repository;
    - a Gradle `init.d/gameplane.gradle` that adds it to `repositories` and, when publishing, to `publishing.repositories`.

    Tokens come from the control-namespace Secrets `gameplane-maven-read` and `gameplane-maven-write`. The write token is rendered **only when `publish` is true**.
  - **Steps**:
    1. Build: Maven runs `mvn <args>` (default `-B clean package`); Gradle runs `gradle <args>` (default `build`).
    2. Find artifacts:
       - Maven: `target/*.jar`.
       - Gradle: `build/libs/*.jar`.
       - Excluded: `original-*`, `*-sources`, `*-javadoc`, `*-plain`.
    3. Publish, if enabled:
       - Maven uploads the main artifact with `deploy:deploy-file`, using the reduced POM when the shade plugin wrote one. There is no second build.
       - Gradle runs `gradle publish`.
       - A publish failure is logged. It sets condition `Published=False` but leaves the build `Succeeded`.
    4. Print `::artifact:: <path> <bytes> <sha256>` per jar, `::published:: true|false` and `::cache:: <bytes>`.
  - **Status**: the reconciler copies Job state into `status` with the backup controller's `mirrorJobStatus` pattern. On completion it parses those markers from the pod log, as the backup controller already does. A failed Job's message comes from `jobFailureMessage`.
  - **Sandbox**:
    - `runAsNonRoot`, UID/GID/fsGroup 65532 (the repo agent's UID), `readOnlyRootFilesystem` with an `emptyDir` `/tmp` and `HOME=/tmp`.
    - Drop all capabilities, `seccompProfile: RuntimeDefault`, `automountServiceAccountToken: false`, and no GitHub token.
    - Job settings: `backoffLimit: 0`, `activeDeadlineSeconds` from the chart (default 1800).
    - Resources from the chart. Label `app.kubernetes.io/name: gameplane-build`.
  - **Retention**: the reconciler deletes a repository's oldest finished builds beyond `--build-keep` (default 10). The Job and its pod go with the CR, so logs of kept builds stay readable.

### Maven repository (chart)

- `mavenRepository.enabled` (default `true`) deploys:
  - Reposilite (Deployment, image pinned to an exact version);
  - a PVC `gameplane-maven` (`helm.sh/resource-policy: keep`, default 10Gi);
  - a Service `gameplane-maven:8080`;
  - an optional Ingress `mavenRepository.ingress.host`.
- Repositories `releases` and `snapshots` are private. `releases` allows redeployment.
- A post-install/upgrade hook Job creates two tokens idempotently through the Reposilite API, using a chart-generated management token:
  - `gameplane-read`: read on `/`;
  - `gameplane-write`: write on `/releases` and `/snapshots`.

  It stores them in Secrets `gameplane-maven-read` and `gameplane-maven-write`. The management token stays in `gameplane-maven-admin`.
- People publish from their machines with their own Reposilite tokens. In v1 an administrator creates them in the Reposilite UI with the management token (OPEN-DECISIONS 1).
- **NetworkPolicies**:
  - `gameplane-build` pods join the public-egress rule (443 and 80, private CIDRs excluded) and get egress to `gameplane-maven:8080`.
  - Reposilite accepts ingress from build pods, from the API (for the Integrations card) and from the ingress controller.

### API

- Routes under `/repositories/{name}/builds` and `GET /integrations/maven`. See [contracts/builds-api.md](contracts/builds-api.md). Home cluster only, like the rest of spec 029.
- **Starting a build**: the API reads `git/status` from the repo agent and records `source.commit` and `source.changes` in the spec, plus the starter in annotations.
- **Logs**: the API streams the build pod's log (it already has `pods/log`).
- **Deploy** runs as the acting user and is not a privileged copy. The API downloads the artifact once through the repo agent and checks it against `status.artifacts[].sha256`; a jar overwritten by a later build answers 409 `artifact_changed`. Then, for each target, it replays the user's own requests through the router, as `ai_run.go` already does for assistant calls:
  1. The server file upload: binary-safe, on remote clusters too, through the files pod when the server is stopped.
  2. A delete per removed jar.
  3. A restart, when asked.

  RBAC applies per target (`servers:write`, which also covers restart). One failed target does not stop the others. The response lists the result per target.
- **Recording deploys**: each deploy is audited (`repository.build.deploy`). It is also appended to the build's `gameplane.local/deployments` annotation, a JSON list capped at 20 entries. The annotation is metadata the operator never reads, so the API writes no status (core rule 10).
- **Clearing the cache** sets the Repository annotation. The Build card's **Save** updates `spec.build` through `PUT /repositories/{name}/build`.

### Assistant

- **New tools** in `ai_builds.go`, repository scope only:
  - `builds_list`, `build_start` (optional `tool`/`jdk`/`args`; no approval), `build_status`, `build_log` (tail);
  - `build_deploy` (`build`, `artifact`, `targets`, `dir`, `filename`, `remove`, `restart`).
- **Approval and modes**:
  - `build_deploy` needs approval in every mode except `bypassPermissions`. Its card lists every target.
  - Plan mode blocks `build_start` and `build_deploy`.
- **Initiative rule**, in the system prompt and the tool description: "Deploy when the user asked for the fix to reach a server, names the target servers or asked through the deploy modal; otherwise, after a build, report the result and stop." In a server conversation that server is the target (revised 2026-11-27). A message seeded by the With Assistant mode counts as an explicit request.
- **Cross-target reads, every scope**:
  - `read_file` and `list_files` take an optional `server` or `repository` argument.
  - A new `repositories_list` joins `servers_list`.
  - `authorize` lets other targets through for **GET only**: `files/{list,read,size}` and the repository Git reads (`git/status`, `git/log`, `git/diff`, `git/commits`).
  - The caller's own RBAC decides, so a server the user may not read is refused.
  - Every write stays on the conversation's own target. `build_deploy` writes only through the deploy endpoint.

### Web

- `web/src/routes/repository/BuildsTab.tsx` with the detail and log components, plus `DeployModal.tsx`.
- `ServerPicker.tsx` is extracted from the `NetworkDetail.tsx` servers card and shared by both.
- The Build card goes in `SettingsTab.tsx`, and `web/src/components/settings/MavenCard.tsx` in Integrations.
- The client lives in `web/src/lib/repositories.ts`, with types in `types.ts`.
- Assistant tool labels go in `web/src/lib/assistant.ts`.
- Strings follow spec 019 (`web.repositories.builds.*`, `web.settings.maven.*`). Tokens come from `globals.css` and components from HeroUI v3.
- The Maven card's "Publishing is opt-in per repository" becomes "Publishing is on by default per repository" (copy fix against the frame).

## Security

- Builds run untrusted code from the repository: Maven and Gradle plugins and build scripts. The sandbox above, the egress policy and the missing service-account and GitHub tokens bound what it reaches.
- The read token can only read the private Maven repository.
- The write token is present only when publish is on. A hostile build script can then overwrite artifacts other builds consume (OPEN-DECISIONS 2).
- Deploy writes nothing the user could not write by hand. It is a replay of their own file calls under their own RBAC, audited per target.

## Out of scope (v1)

- External or on-device runners.
- Builds for languages other than Java.
- Multi-module Maven publish: only the main artifact of the root project is published.
- Build triggers on push or schedule.
- Artifact storage outside the working copy: an older build's jar is gone once a later build overwrites it.
- Repositories on remote clusters (spec 029 OPEN-DECISIONS 1).
