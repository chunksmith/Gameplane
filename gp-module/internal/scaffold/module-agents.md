# Gameplane module: notes for AI assistants

This directory is a [Gameplane](https://gameplane.net) game module, a reusable
blueprint that the Gameplane operator turns into a game server on Kubernetes.
Gameplane is newer than most model training data, so do not borrow field names
from Pterodactyl eggs, AMP, LinuxGSM or Agones. Use only the fields shown here,
in the editor schemas under `../.schema/` (when that directory exists), or in
the full reference: https://gameplane.net/docs/module-authoring/

## Files

| File | Purpose |
|---|---|
| `module.yaml` | Catalog metadata: name, version, summary, categories |
| `template.yaml` | The `GameTemplate`: image, ports, storage, config, console |
| `README.md` | Shown in the catalog detail drawer; required for packaging |
| `icon.png` | Optional catalog icon, 256×256, at most 512 KiB |
| `AGENTS.md` | This file; not part of the published bundle |

## Workflow

Run these from this directory after every change, and fix every finding
before you call the module done:

```sh
gp-module validate . --strict
gp-module preview . --memory=4Gi
gp-module package . --output ../my-game.tar.gz
```

`validate` checks offline and reports the file and line of each finding;
`--strict` also fails on warnings. `preview` shows the env vars, config values
and memory math a new server would get. `package` builds the bundle; keep its
output outside this directory.

## module.yaml

```yaml
apiVersion: gameplane.local/module/v1
name: my-game
displayName: My Game
version: 1.0.0
game: my-game
categories: [Survival, Co-op]
summary: Dedicated server for My Game
license: MIT
icon: icon.png
```

- `name` is a DNS-1123 label and must equal this directory's name.
- `version` is semver and must equal the OCI tag the bundle is pushed under.
- `categories` should use the canon: Survival, Sandbox, Shooter, Simulation,
  Building, Adventure, Horror, Co-op, PvP, Modded, Creative. Keep the list
  identical in `template.yaml`.

## template.yaml

```yaml
apiVersion: gameplane.local/v1alpha1
kind: GameTemplate
metadata:
  name: my-game
  labels:
    gameplane.local/module: my-game
spec:
  displayName: My Game
  game: my-game
  version: 1.0.0
  categories: [Survival, Co-op]
  description: |
    Dedicated server for My Game.
  image: ghcr.io/example/my-game:1.2.0@sha256:<64-hex-digest>
  env:
    - name: SERVER_NAME
      value: Gameplane
  ports:
    - name: game
      containerPort: 27015
      protocol: UDP
      advertise: true
  storage:
    size: 10Gi
    mountPath: /data
  resources:
    requests:
      cpu: 500m
      memory: 2Gi
    limits:
      cpu: "2"
      memory: 4Gi
  configSchema:
    - name: MAX_PLAYERS
      displayName: Max players
      type: int
      default: "16"
    - name: SERVER_PASSWORD
      displayName: Password
      type: password
  rcon:
    protocol: none
  consoleMode: pty
  capabilities:
    lifecycle:
      stop: ["save", "exit"]
```

## Rules that are easy to get wrong

### Images

- `spec.image` and the `default: true` entry of `spec.versions` must be pinned
  as `repo:tag@sha256:<digest>`. Resolve the digest with `crane digest <image>`
  or `docker buildx imagetools inspect <image>`. Never invent a digest; if you
  cannot resolve one, ask the human.
- Any other version entry may track a moving tag only when its image line ends
  with a `# gameplane:floating` comment and its `displayName` says so.

### Ports, storage and user

- Ports go in `spec.ports`. `protocol` is `TCP` or `UDP`; set `advertise: true`
  only on ports players connect to.
- Never use port 8090 or 9090: the Gameplane agent sidecar in the same pod
  binds them.
- `storage.mountPath` is where the game writes its world and config files.
  Backups snapshot this whole directory.
- If the image refuses to run as root or needs a fixed uid, set
  `spec.security.runAsUser`, `runAsGroup` and `fsGroup`.
- Add `spec.probes.readiness` when the image offers a health endpoint or
  command.

### Configuration

- Each `configSchema` field becomes an input in the New Server wizard and, by
  default, an env var with the same name. `type` is `string`, `int`, `bool`,
  `enum` (list the options in `enum: [...]`) or `password`. `default` is
  always a string.
- Env precedence, lowest to highest: the template's `env`, the selected
  version's `env`, resolved `configSchema` values, the GameServer's own
  `spec.env`.
- `password` values are stored in a Secret and never appear inline.
- For games that read a config file instead of env vars, mark fields
  `target: file` and render them with `spec.configFiles`: `path` is relative to
  `storage.mountPath`, and `template` is a Go `text/template` that reads
  `.Values.<FIELD>` and `.Server.Name`.
- `autoFromMemoryLimit: {percent: 75}` sizes a memory value, such as a JVM
  heap, from the container memory limit (rendered like `3072M`).
- Renaming or removing a field breaks servers that stored a value for it. Add
  a new field instead.

### Console

- `rcon.protocol` is one of `source`, `telnet`, `websocket`, `battleye`,
  `satisfactory`, `palworld`, `nuclearoption`, `rest`, `cli` or `none`. For a
  password-protected console set `rcon.port` and `rcon.passwordEnv`, the env
  var the image reads the password from; the operator generates the password.
- Games that read commands on stdin use `rcon.protocol: none` with
  `consoleMode: pty`.
- `logPath` is an absolute in-container path to the game's log file. Omit it
  when the game logs only to stdout.

### Capabilities

- `spec.capabilities` turns console commands into dashboard features:
  `players` (kick, ban, unban, whitelist and list, templated with
  `{{.Player}}` and `{{.Reason}}`), `quiesce` (commands run around a backup),
  `lifecycle.stop` (graceful stop sequence), `actions` (named buttons),
  `status` and `mods`.
- All of them need a console protocol other than `none`, except
  `lifecycle.stop`, which also works with `consoleMode: pty`.
- Declare only commands the game really accepts; check its documentation. A
  missing block just hides the feature, while a wrong command breaks it.

### Versions

- `spec.versions` lists selectable versions. Each entry has an `id` (at most
  40 characters), a `displayName` and an `image`, plus optional `env`,
  `loader` and `gameVersion`. Mark one entry `default: true`. At most 64
  entries.

## When unsure

Read the matching section of https://gameplane.net/docs/module-authoring/, or
follow an official module from https://github.com/GameplanePanel/module:
`valheim` (stdin console, version channels), `minecraft-java` (RCON, mods,
memory sizing), `terraria` (config files) and `factorio` (game-managed RCON
password).
