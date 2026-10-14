# gp-module — Specification

**Status:** Active Development  
**Module / command:** `github.com/GameplanePanel/gameplane/gp-module`  
**Dependencies:** `gopkg.in/yaml.v3`, `k8s.io/apimachinery` (Go 1.26+)

## Purpose

`gp-module` is the unified developer toolkit for authoring, validating, previewing, and packaging Gameplane game modules. It provides:
1. **Scaffolding (`init`)**: Interactive and non-interactive generation of schema-compliant module directories across `steamcmd`, `java`, and `generic` archetypes with DNS-1123 validation.
2. **Offline Validation (`validate`)**: Static offline checking of `module.yaml` metadata, CRD schemas, image digest pinning, canonical categories, port bounds/collisions, and configuration rules with exact source line-number diagnostics via `yaml.v3`.
3. **Dry-Run Preview (`preview`)**: Simulation of runtime server creation from `template.yaml`, evaluating dynamic memory limits (`autoFromMemoryLimit`) and environment variable precedence using native Kubernetes resource types.
4. **OCI Packaging (`package`)**: Asset size sanity checking (icon $\le$ 512 KiB, bundle $\le$ 1 MiB) and automated bundle export via ORAS or local `.tar.gz` archive.

## Responsibilities

- Generate valid `module.yaml`, `template.yaml`, `README.md`, and `icon.png` from archetype definitions, plus a static `AGENTS.md` guide for AI assistants (CLI scaffold only, not a bundle file).
- Enforce Kubernetes DNS-1123 label naming standards: 1–63 characters, matching `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`.
- Perform static preflight checks completely offline without network or cluster connectivity.
- Parse YAML AST to report exact file and line numbers for all diagnostic findings.
- Replicate Gameplane operator runtime logic for memory percentage calculations:
  $$\text{mib} = \lfloor \text{bytes} \times \text{percent} / 100 / (1024 \times 1024) \rfloor \implies \text{"<mib>M"}$$
- Export valid OCI artifact bundles matching Gameplane's canonical media types and annotations.
- Provide Go library functions under `pkg/` (backed by `internal/`) reusable by `api/` for web dashboard integration.

## Non-goals / boundaries

- Does not manage live Kubernetes clusters or CRD reconciliation (owned by `operator/`).
- Does not reverse engineer closed-source game wire protocols or network payloads (owned by game authors).
- Does not generate custom graphic art for icons (creates placeholder PNG only).
- Does not distribute proprietary game server binaries.

## Directory & package layout

```text
gp-module/
├── cmd/
│   └── gp-module/
│       ├── main.go               # Root CLI entrypoint and subcommand routing
│       ├── init.go               # 'init' command flags and interactive prompts
│       ├── validate.go           # 'validate' command flags and reporting
│       ├── preview.go            # 'preview' command flags and formatting
│       └── package.go            # 'package' command flags and packaging
├── pkg/                          # Public Go API exported to api/ and other modules
│   ├── archetypes/               # Archetypes and icon helpers
│   ├── packager/                 # Archive creation and size limits
│   ├── preview/                  # Runtime simulation and auto memory
│   ├── scaffold/                 # File generation from archetypes
│   └── validator/                # Validation and finding reports
├── internal/
│   ├── archetypes/
│   │   ├── archetypes.go         # Archetype definitions (steamcmd, java, generic) and placeholder icon generator
│   │   └── archetypes_test.go    # Archetype unit tests
│   ├── common/
│   │   ├── validation.go         # DNS-1123 validation and naming helpers
│   │   └── yaml_ast.go           # YAML AST line-number locator utilities
│   ├── scaffold/
│   │   ├── scaffold.go           # Scaffolding engine and directory builder
│   │   ├── module-agents.md      # Embedded AGENTS.md written into scaffolded modules
│   │   └── scaffold_test.go      # Scaffolding unit tests
│   ├── validator/
│   │   ├── validator.go          # Core offline validator orchestrator
│   │   ├── rules.go              # Lint rules implementation
│   │   ├── schema.go             # Schema conformance verification
│   │   ├── report.go             # Diagnostic formatter and JSON reporter
│   │   └── validator_test.go     # Validator unit tests
│   ├── preview/
│   │   ├── preview.go            # Manifest simulator and env merger
│   │   ├── memory.go             # autoFromMemoryLimit calculator
│   │   └── preview_test.go       # Preview unit tests
│   └── packager/
│       ├── packager.go           # OCI bundle packager and size checker
│       └── packager_test.go      # Packager unit tests
├── go.mod                        # Go module declaration
├── specs.md                      # Architecture and boundaries specification
└── .testcoverage.yml             # 80% coverage threshold gate
```

## Key Invariants

1. **Strictly Offline First.** Scaffolding, validation, and preview operations NEVER make outbound network calls or require a running Kubernetes cluster.
2. **Zero Code Duplication with Web UI.** Core scaffolding, validation, and preview engines are exported via `pkg/` as pure Go libraries directly imported by `api/internal/handlers/modules_builder.go`.
3. **Deterministic Memory Arithmetic.** Memory calculations derived from `autoFromMemoryLimit` use identical integer arithmetic and rounding to the Gameplane operator.
4. **Non-destructive Directory Creation.** Scaffolding refuses to overwrite an existing directory unless `--overwrite` is explicitly specified.
5. **Non-root Preset Defaults.** The `steamcmd` archetype renders a `spec.security` block (`runAsUser`, `runAsGroup` and `fsGroup` set to `1000`, the image's `steam` user), so a scaffolded template runs its game container as a non-root user. The block stays when the author supplies another image, and the generated README says to adjust it for that image.
