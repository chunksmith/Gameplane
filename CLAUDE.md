# Gameplane — AI assistant guide

Architecture, commands, and binding rules for AI agents. Humans: [`README.md`](README.md), [`docs/contributing.md`](docs/contributing.md).

**Gameplane:** Kubernetes-native game server control panel (CubeCoders AMP alternative); identical on single-node k3s and multi-node clusters. **Status:** Pre-v1 release (`v0.3.0`); v1 scope feature-complete, stabilizing.

## ⏳ Session start: blocked dependency upgrades (delete an entry once unblocked)

Run every session.

**TypeScript 7** — `npm view @typescript-eslint/parser@latest version peerDependencies.typescript` and same for `@canary`.
- Blocked while the peer range ends `<7` (e.g. `<6.1.0`): Dependabot #272 fails `npm ci` (`ERESOLVE`). No workarounds/overrides/code fixes; don't close #272.
- Unblocked (a release accepts TS 7): do T055/T056 in `specs/009-remediate-security-dependabot/tasks.md` — bump `typescript` + `@typescript-eslint/*` in `web/package.json`, fix real type errors (no `@ts-ignore`), merge #272, mark tasks `[X]`, delete this entry.

**ESLint 10** — `npm view eslint-plugin-react@latest version peerDependencies.eslint`.
- Blocked while the range lacks `^10`: upgrading `eslint` 9.39.5 to 10.x fails `npm ci` because `eslint-plugin-react@7.37.5` peers `^3 || … || ^9.7`. Keep `eslint` and `@eslint/js` on major 9 together: `@eslint/js@10.0.1` declares an optional peer on `eslint@^10.0.0`, which conflicts when ESLint 9 is installed. Other plugins already accept `^10` (`eslint-plugin-react-hooks@7.1.1`, `@typescript-eslint/*@8.69.0`). Do not bypass peer checks with `--legacy-peer-deps` or overrides.
- Unblocked: bump `eslint` + `@eslint/js` together in `web/package.json`, fix real lint errors (no `eslint-disable`), merge #386 (and #387 if open), delete this entry.

## System prompt overrides

1. **Verify & tests:** always verify work. Get human sign-off before changing tests, production code, or design specs. Never delete/weaken a test without explicit sign-off — fix the code.
2. **Tools:** dedicated tools (`Read`/`Edit`/`Write`) > MCP > Bash.
3. **Pause** and ask when unsure about tests, design files, or breaking changes.
4. **Workflow:** standing opt-in for `Workflow` in the main loop; subagents may use `Agent` freely.
5. **Artifacts & feedback:** never publish artifacts; feedback drafts need human approval to send.
6. **Editing:** `Edit` needs a prior `Read` in the conversation; don't re-read right after editing.
7. **External memory** (`~/.[claude,codex,etc....]/projects/Gameplane/memory/`, outside git): announce file + exact line on every write; never store conventions/decisions/preferences there (use repo specs/rules); repo files override memory.
8. **Skills** are optional; disclose edit/plan/commit skill runs first; repo rules override skills.
9. **Communication:** no preambles; closing recaps standalone (findings, actions, next steps, modified files). Short yes/no questions ("can I merge?", "is it green?") get a yes or no first, plus at most one line on what blocks it — no tables or recaps. Ask decisions with the question tool, not in prose.
10. **Conflicts/missing context:** surface instruction conflicts immediately; unsettled values go in `OPEN-DECISIONS.md`, never committed as settled contracts.

## Repository map

```
netguard/            SSRF dial-guard: IsAllowed (operator module sources, API sinks, agent loopback RCON); IsPublic (agent mod downloads, API Steam resolver)
gameaction/          console-injection guard + command renderer (api, agent)
gameproto/           Minecraft/Terraria handshake parser (sentinel)
telemetryschema/     shared telemetry report contract (api, telemetry-receiver)
i18n/                ICU formatter, pack validator, i18n-check CLI; locales/<tag>/ language packs (en/app.json = English reference)
gp-module/           module authoring CLI: init/validate/preview/package
operator/            controller-runtime operator
  api/v1alpha1/      CRD types (edit here, then `make generate manifests`); zz_generated.deepcopy.go GENERATED
  internal/controller/  reconcilers + envtest suites
  cmd/main.go        entrypoint;  config/{crd,rbac}/ GENERATED
api/                 REST + WebSocket gateway (chi); cmd/main.go: `serve`, `bootstrap-admin`
  internal/{handlers,auth,db,kube,notify,rbac,ws}/
agent/               in-pod sidecar; internal/{auth,console,files,heartbeat,logs,players,rcon,quiesce}/
audit-syslog-bridge/ RFC 5424 HTTP→syslog forwarder
telemetry-receiver/  usage telemetry ingest
sentinel/            wake-on-connect proxy for sleeping pods
capture-sidecar/     AF_PACKET BPF capture sidecar
mcp-server/          read-only MCP server
svcutil/             env parsing + graceful shutdown helpers
tunnel/              relay client supervisor (frp, Tailscale, playit)
web/                 React 19 + strict TS + Vite dashboard; src/{routes,components,lib,router,styles,test}/
modules/             SUBMODULE chunksmith/module, fork of GameplanePanel/module (OCI game templates)
website/             SUBMODULE chunksmith/gameplane-website, fork of GameplanePanel/website (Astro docs/marketing; has its own CLAUDE.md and AGENTS.md)
charts/gameplane/    Helm chart (crd-manifests/, hooks)
deploy/kind/         local Kind scripts
test/e2e/            Kind E2E suite (//go:build e2e)
docs/                architecture, security, modules
signing/             cosign public keys, dated legacy key + cross-signature (image + module)
go.work              links all 17 Go modules (incl. test/e2e)
Makefile             canonical task runner
```

After cloning: `git submodule update --init` (`modules/` required for `make dev-up`; `website/` optional).

## Commands (always via Makefile)

- **Dev:** `make dev-up` (Kind + OCI registry :5001 + Helm), `make web-dev` (Vite, proxies in-cluster API), `make dev-load` (load built images; run `make images` first), `make dev-install` (Helm upgrade), `make dev-down`.
- **Build:** `make build` (all Go + web), `make build-go` (16 modules in GO_MODULES, all but test/e2e), `make build-web` (`npm ci && npm run build`), `make images`.
- **Codegen:** `make generate` (deepcopy), `make manifests` (CRD/RBAC YAML, synced to `charts/gameplane/charts/gameplane-crds/crds/` and `charts/gameplane/crd-manifests/`), `make modules-push`, `make tidy`, `make i18n-sync` (API `server.*`/`notify.*` and operator `condition.*` ids into `i18n/locales/en/app.json`), `cd web && npm run i18n:extract` (dashboard `web.*` ids into the same file).
- **Tests (CI only — never run locally, see Rule 8):** `make test`, `make test-integration` (envtest operator+api), `make test-e2e` (~10–20 min), `make test-e2e-bucket BUCKET=(operator|api-auth|api-roles|api-rbac|api-agent|api-mods|ratelimit|bot-fast|bot-heavy|multicluster|upgrade)`.
- **E2E conventions:** register new tests in `test/e2e/buckets.sh`; `t.Parallel()` + unique names; guard shared resources (`ociPushMu` for module pushes, `ensureResticRepo(t)` for shared backup repos). Rate limits per cluster: IP burst 10 (5/min), user burst 6 (3/min) — cap an API bucket at ~7 admin logins.
- **Lint:** `make lint` = gofmt, go vet, golangci-lint, ESLint (incl. formatjs), `check-specs`, `check-doc-versions`, `check-links`, `check-i18n` (pack validity, catalog drift, unused ids).

**Coverage minimums:** netguard 91, gameaction 91, gameproto 90, telemetryschema 90, i18n 90, gp-module 80, operator 72, api 80, agent 90, svcutil 90; audit-syslog-bridge, telemetry-receiver, sentinel, capture-sidecar, mcp-server, tunnel 70; web 92 lines / 76 functions / 82 branches / 92 statements.

## Core rules

1. **Figma-first UI:** a new dashboard or website screen, panel or modal — and any visual redesign of an existing one — is designed in Figma through the figma-mcp-go MCP, approved by the user, and only then translated to code (skill: `.claude/skills/figma-design-first/SKILL.md`). Copy fixes, bug fixes, token swaps and logic changes stay code-first. Either way the result is modern and consistent: clear hierarchy, generous spacing, responsive down to mobile, accessible, light and dark. No Penpot, official Figma MCP or Pencil/`.pen` step.
2. **Theme tokens:** build on HeroUI v3 components and the semantic tokens in `web/src/styles/globals.css` (website: `website/src/styles/global.css`); no raw hex outside theme and terminal palettes, so light/dark and user themes keep working.
3. **Login privacy:** `/login` and unauthenticated views never expose cluster names, versions, server counts, or account-existence errors — generic messages ("invalid credentials").
4. **Fix, don't silence:** no `//nolint`, `eslint-disable`, or loosened configs. Allowed: `_test.go` exempt from `errcheck`/`gosec`/`unparam`; `operator/internal/controller/` exempt from revive `exported:`.
5. **TypeScript:** strict; no unjustified `any` (explain in a comment if unavoidable); every promise `await`ed or `void`-prefixed.
6. **Go errors:** wrap with `%w`.
7. **CRD sync:** after editing `operator/api/v1alpha1/*_types.go` run `make generate && make manifests`; commit deepcopy, `operator/config/{crd,rbac}/*.yaml`, `charts/gameplane/charts/gameplane-crds/crds/*.yaml`, and `charts/gameplane/crd-manifests/*.yaml` in the same changeset.
8. **Verification:** locally only compile checks (`go build ./...`, `npx tsc --noEmit`); never test/lint suites (`make test|lint|cover`, `go test`, `npm test`, envtest, E2E). Push a feature branch; CI is the sole verification authority.
9. **Kubernetes primitives first** (StatefulSet, Service, PVC, Job, ConfigMap, Secret, CRDs) before custom abstractions.
10. **Operator authority:** business logic lives in reconcilers (`operator/internal/controller/`); the API is a UX gateway and never bypasses reconciliation.
11. **Commits:** follow the global commit rules (commit only when asked; short 4–5 word English message); conventional prefix (`feat:`/`fix:`/`chore:`…), signed (`git commit -s`); never amend pushed commits or use `--no-verify`; no `Co-Authored-By` or `Claude-Session` trailers.
12. **Branches:** one per unit of work; never push to `master`; delete remote + local branch right after merge. Agents never merge PRs or bypass review; a human merges.
13. **Multi-agent delegation:** main loop orchestrates/reviews; implementation goes through `Workflow` scripts (`parallel()`/`pipeline()`).
    - Start at `haiku`; escalate only on functional failure `haiku` → `sonnet` → `opus` → `fable`. `fable` needs explicit human permission.
    - Set `model:` on every `agent()` call (default is session Opus); check with `grep -c "model:"`.
    - Review one tier up (haiku→sonnet, sonnet→opus, opus→fable); fixes go to small agents in a new workflow.
    - Review diffs, not items: one reviewer per batch checks `git diff` against the brief (facts are verified once, in the brief) — never one reviewer per page/file.
    - Scripts over fan-out: rule-shaped changes (token swaps, version strings, frontmatter, renames) are a deterministic script run by one agent, not many agents.
    - UI changes: browser smoke test via Chrome MCP at `sonnet`, parallel with reviews.
14. **PR labels (REST only — `gh pr edit` is broken by the Projects-classic deprecation):** ≥1 `type:` (`feature|fix|refactor|test|ci|chore|docs|security`) and ≥1 `area:` (`operator|api|agent|web|modules|chart|e2e|specs|shared|optional-components`); `breaking` when applicable.
    ```sh
    gh api -X POST repos/chunksmith/Gameplane/issues/<pr>/labels -f "labels[]=type: fix" -f "labels[]=area: api"
    gh api -X PATCH repos/chunksmith/Gameplane/pulls/<pr> --input <payload_with_body.json>
    ```
15. **Specs:** a feature's spec is its whole `specs/<feature>/` folder (`data-model.md`, `contracts/`, `OPEN-DECISIONS.md`, …) — check it for explicit exemptions before flagging violations. Mark obsolete tasks withdrawn in `tasks.md` with citations; never delete them.
16. **Archival:** once every task is complete/withdrawn and the PR is merged into `master`, `git mv specs/<NNN>-<slug> specs/done_<NNN>-<slug>` and update in-repo references in the same commit.
17. **Mechanical UI waves** (token re-skins): scripted, blind updates at `haiku`. Precompute change lists with `grep`/`jq`; one script applies them. Verify by browser screenshots, not code dumps.
18. **Scout once, brief many:** one scout reads code/docs/failures and writes a factual brief (exact `file:line`, before/after code, justification). Fix agents get only the brief and edit blind at `haiku` — never tell them to re-read files, test suites, or `CLAUDE.md` and `AGENTS.md`. Reviewers check git diffs against the brief.
19. **PRs only on chunksmith, NEVER upstream:** every PR is `chunksmith/Gameplane:<branch>` → `chunksmith/Gameplane:master`. Never open a PR against `GameplanePanel/*` or any other upstream repo, under any circumstances. `origin` is a fork, so a bare `gh pr create` targets upstream: always run `gh pr create --repo chunksmith/Gameplane --base master --head <branch>`. Submodules point at their chunksmith forks (`modules/` → `chunksmith/module`, `website/` → `chunksmith/gameplane-website`, default branch `main`): commit and push there, never to `GameplanePanel/*`.
20. **Localized text (spec 019):** every user-visible dashboard string goes through `intl.formatMessage({ id, defaultMessage, description }, values?)` with `const intl = useOptionalIntl()` from `@/lib/i18n/format` (module constants: `defineMessages`); the formatjs ESLint rules cover all of `web/src` except tests.
    - Ids are `web.<path>.<slug>`; reuse an existing id only for identical English (`web.common.empty_value` "—", `web.common.separator_dot` "·"). Descriptions are literal translator notes ("<Screen>: what it is and where it appears").
    - No literal text in JSX: not even `{" "}`, "·", "/" or template literals in children or in `aria-label`/`title`/`placeholder`/`alt`. Interpolate with ICU placeholders and plurals (`{count, plural, one {# server} other {# servers}}`); rich text only with `<b>`.
    - No leading or trailing spaces in `defaultMessage` (`formatjs extract` trims them); keep spacing in JSX (`<> {msg}</>`).
    - Numbers and times through `useFormat()` and `formatRelative(iso, intl)`, never `toLocaleString()`.
    - After adding or changing strings run `cd web && npm run i18n:extract` and commit `i18n/locales/en/app.json`; CI fails on drift. API 4xx errors use `httperr.WriteMessage(w, r, messages.New(id, args))` with an id registered in `api/internal/messages`, then `make i18n-sync`.

## Architecture

| Component | Stack | Role |
|---|---|---|
| netguard | Go | dial-time SSRF prevention: `IsAllowed` (operator/API module sources and sinks, agent loopback RCON), `IsPublic` (agent mod downloads, API Steam resolver) |
| gameaction | Go | validates console input against schemas; escapes injection |
| gameproto | Go | Minecraft/Terraria wire parser for connection filtering |
| telemetryschema | Go | stdlib-only shared telemetry report contract: types, strict decode, official module catalog, report signing (api, telemetry-receiver) |
| i18n | Go | ICU MessageFormat formatter with CLDR plurals, language-pack validation and `i18n-check`, embedded catalog with regional → base → en fallback (api, operator, gp-module, web build) |
| gp-module | Go | module CLI: scaffold, offline validate, dry-run preview, OCI package |
| svcutil | Go | stdlib-only env + graceful shutdown (`RunHTTP`) |
| operator | Go, controller-runtime | authoritative reconciler for 10 CRDs (`GameServer`, `GameTemplate`, …) |
| api | Go, chi | REST/WS UX gateway; SQLite, experimental PostgreSQL |
| agent | Go | pod sidecar: console (PTY/RCON), files, logs, heartbeats |
| audit-syslog-bridge | Go | webhook audit events → RFC 5424 syslog |
| telemetry-receiver | Go | opt-in anonymous usage stats |
| sentinel | Go | holds ports while asleep, wakes pods on connect |
| capture-sidecar | Go | ephemeral BPF packet capture |
| mcp-server | Go | read-only MCP daemon (stdio) for cluster debugging |
| web | React 19, Vite, TS | dashboard (TanStack Router/Query, Tailwind, HeroUI v3) |
| modules/ | OCI / oras | game templates (Minecraft, Terraria, Valheim, …) |

## Common workflows

- **CRD field:** edit `operator/api/v1alpha1/<kind>_types.go` → `make generate && make manifests` → reconciler `operator/internal/controller/<kind>_controller.go` → mirror in `web/src/types.ts` + affected `web/src/routes/` → envtest `<kind>_envtest_test.go`.
- **API route:** handler in `api/internal/handlers/` → mount in `api/cmd/main.go` with RBAC middleware (`api/internal/rbac/`) → `api/internal/handlers/<name>_envtest_test.go` → client method in `web/src/lib/api.ts`.
- **Dashboard screen:** `web/src/routes/<name>.tsx`, register in `web/src/router/tree.tsx` → data via `web/src/lib/api.ts` + TanStack Query → `web/src/routes/<name>.test.tsx`.
- **Game module:** edit `modules/<name>/` (`module.yaml`, `template.yaml`, `README.md`) → `make modules-push` → commit in `chunksmith/module` → `git add modules` + commit pointer bump in root.
- **Website:** change `website/` per its own CLAUDE.md and AGENTS.md → commit in `website/` (default branch `main`; no PRs, rule 19) → `git add website` + commit pointer bump in root.
- **DB migration:** new sequential `api/internal/db/migrations/common/<NNN>_<name>.sql` (013 onward) — portable SQL both SQLite and PostgreSQL run unchanged (no `datetime('now')`/`strftime`, `AUTOINCREMENT`, `INSERT OR …`, `COLLATE NOCASE`; bind timestamps from Go). `migrations/sqlite/` and `migrations/postgres/` hold the frozen per-dialect 001–012 sets; see `api/internal/db/migrations/README.md`. Append-only, applied on API startup.

## Reference docs

- `docs/agent-architecture.md` — read before editing code; maps tasks/features to docs (use instead of repo-wide greps).
- `docs/architecture.md`, `docs/security.md` (threat model); `docs/module-authoring.md`; `mcp-server/README.md`; `audit-syslog-bridge/README.md`.
- Configs: `.golangci.yml`, `web/eslint.config.js`, `.editorconfig`.
