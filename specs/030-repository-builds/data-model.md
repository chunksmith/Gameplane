# Data model: Repository builds

## `Repository` (spec 029) additions

```go
type RepositorySpec struct {
    // existing: URL, Branch, Storage
    Build *RepositoryBuildDefaults `json:"build,omitempty"`
}

type RepositoryBuildDefaults struct {
    Tool    BuildTool `json:"tool,omitempty"`    // +kubebuilder:validation:Enum=auto;maven;gradle, default auto
    JDK     int32     `json:"jdk,omitempty"`     // +kubebuilder:validation:Enum=17;21;25, default 21
    Args    string    `json:"args,omitempty"`    // MaxLength 512; empty = tool default
    Publish *bool     `json:"publish,omitempty"` // nil = true
}

type RepositoryStatus struct {
    // existing fields
    CacheClearedAt *metav1.Time `json:"cacheClearedAt,omitempty"`
}
```

Annotation `gameplane.local/clear-cache: <RFC 3339>`. It is set by the API. The reconciler acts on it when the value is newer than `status.cacheClearedAt`.

Owned objects added by the reconciler:

| Object | Name | Notes |
|---|---|---|
| PVC | `<repo>-build-cache` | RWO, `--build-cache-size` (default 5Gi), storage class of `<repo>-data` |

## `RepositoryBuild` (new)

Name `<repo>-build-<N>`, where `N` is the repository's next build number. The API takes it from the highest `gameplane.local/build-number` label plus one and retries on `AlreadyExists`.

Owner reference: the `Repository`, with `controller: true`, so a deleted repository takes its builds along.

```go
type RepositoryBuildSpec struct {
    RepositoryRef string      `json:"repositoryRef"`        // immutable
    Tool          BuildTool   `json:"tool"`                 // resolved by the API: auto|maven|gradle
    JDK           int32       `json:"jdk"`
    Args          string      `json:"args,omitempty"`
    Publish       bool        `json:"publish"`
    Source        BuildSource `json:"source,omitempty"`     // informational, set by the API
}

type BuildSource struct {
    Commit  string `json:"commit,omitempty"`  // short SHA of HEAD at start
    Changes int32  `json:"changes,omitempty"` // uncommitted files at start
}

type RepositoryBuildStatus struct {
    Phase          BuildPhase         `json:"phase,omitempty"` // Queued|Pending|Running|Succeeded|Failed
    Tool           BuildTool          `json:"tool,omitempty"`  // detected tool when spec.tool is auto
    StartTime      *metav1.Time       `json:"startTime,omitempty"`
    CompletionTime *metav1.Time       `json:"completionTime,omitempty"`
    Message        string             `json:"message,omitempty"`
    Artifacts      []BuildArtifact    `json:"artifacts,omitempty"`
    Published      bool               `json:"published,omitempty"`
    CacheBytes     int64              `json:"cacheBytes,omitempty"`
    Resources      corev1.ResourceRequirements `json:"resources,omitempty"` // limits the Job ran with
    Conditions     []metav1.Condition `json:"conditions,omitempty"`     // JobCreated, Published
}

type BuildArtifact struct {
    Path   string `json:"path"`   // relative to the working copy, e.g. target/LitHomes-1.0.0.jar
    Size   int64  `json:"size"`
    SHA256 string `json:"sha256"`
    Shaded bool   `json:"shaded,omitempty"` // an original-<name> sibling existed
}
```

**Phases**:

| Phase | Meaning |
|---|---|
| `Queued` | Another build of the same repository is active. |
| `Pending` | The Job exists, but its pod is not running yet. |
| `Running` | The build pod is running. |
| `Succeeded` / `Failed` | The Job finished. Cancelling deletes the CR instead of ending in a phase. |

**Labels**:
- `gameplane.local/repository=<repo>`
- `gameplane.local/build-number=<N>`

**Annotations**, set by the API:
- `gameplane.local/started-by-id`, `gameplane.local/started-by` (display name);
- `gameplane.local/started-via` (`dashboard` | `assistant`);
- `gameplane.local/deployments`: a JSON list of `Deployment`, newest last, capped at 20.

```ts
interface Deployment {
  id: string; time: string; artifact: string;
  dir: string; filename: string; removed: string[]; restart: boolean;
  actor: { id: string; name: string }; via: "dashboard" | "assistant"; approvedBy: string | null;
  targets: { cluster: string; namespace: string; server: string; ok: boolean; error: string | null }[];
}
```

## Build Job

| Field | Value |
|---|---|
| Name | `<build>`, truncated with the backup controller's helper |
| Labels | `app.kubernetes.io/name: gameplane-build`, `app.kubernetes.io/instance: <repo>`, `gameplane.local/build-number` |
| Affinity | required podAffinity: `gameplane-repo` / `<repo>`, `kubernetes.io/hostname` |
| Volumes | `<repo>-data` → `/repo` (workdir), `<repo>-build-cache` → `/cache`, Secret `<build>` → `/etc/gameplane-build` (read-only), `emptyDir` → `/tmp` |
| Env | `HOME=/tmp`, `GRADLE_USER_HOME=/cache/gradle`, `MAVEN_OPTS` / `-Dmaven.repo.local=/cache/m2`, `GAMEPLANE_MAVEN_URL` |
| Security | pod `runAsNonRoot`, `runAsUser`/`runAsGroup`/`fsGroup` 65532, seccomp `RuntimeDefault`; container `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, drop `ALL` |
| Job | `backoffLimit: 0`, `activeDeadlineSeconds: --build-deadline` (default 1800), no TTL (lives with the CR), `automountServiceAccountToken: false` |

**Secret `<build>`**, owned by the build, with these keys:
- `build.sh`;
- `settings.xml`;
- `gameplane.gradle`;
- `read-token`;
- `write-token`, only when `spec.publish`.

**Log markers**, one per line, parsed on completion:

```
::artifact:: target/LitHomes-1.0.0.jar 5662310 9f86d0…
::published:: true
::cache:: 190840832
```

## Operator flags and chart values

| Flag | Value | Default |
|---|---|---|
| `--build-maven-image` | `repositories.build.images.maven` | `maven:3.9.11-eclipse-temurin-{jdk}` |
| `--build-gradle-image` | `repositories.build.images.gradle` | `gradle:9.9.2-jdk{jdk}` |
| `--build-cpu-request`, `--build-memory-request`, `--build-cpu-limit`, `--build-memory-limit` | `repositories.build.resources` | `500m`, `768Mi`, `2`, `2Gi` |
| `--build-cache-size` | `repositories.build.cacheSize` | `5Gi` |
| `--build-deadline` | `repositories.build.deadlineSeconds` | `1800` |
| `--build-keep` | `repositories.build.keep` | `10` |
| `--maven-url` | derived from `mavenRepository` | `http://gameplane-maven.<ns>.svc:8080`; empty when disabled |

Exact image tags are confirmed against the registries at implementation time (OPEN-DECISIONS 3).
