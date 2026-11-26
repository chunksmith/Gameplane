export const GIT_SOURCE_CONTAINER = "git-source";
export const GIT_SOURCE_IMAGE = "alpine/git:2.43.0";

export interface GitSource {
  url: string;
  ref: string;
  secretName: string;
  secretKey: string;
}

export const emptyGitSource: GitSource = { url: "", ref: "", secretName: "", secretKey: "" };

const script = `set -eu
umask 002
export HOME=/tmp GIT_DIR=/target/.gameplane-git GIT_WORK_TREE=/target GIT_TERMINAL_PROMPT=0
git config --global --add safe.directory '*'
if [ ! -d "$GIT_DIR" ]; then
  git init -q
  git config core.logAllRefUpdates false
fi
if [ -n "\${GIT_CREDENTIAL:-}" ]; then
  case "$GIT_URL" in
    http*) git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GIT_CREDENTIAL"; }; f' ;;
    *) (umask 077; printf '%s\\n' "$GIT_CREDENTIAL" > /tmp/key)
       export GIT_SSH_COMMAND="ssh -i /tmp/key -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null" ;;
  esac
fi
ref=\${GIT_REF:-HEAD}
want=$(git ls-remote "$GIT_URL" "$ref" | head -n 1 | cut -f 1) || true
have=$(git rev-parse -q --verify HEAD) || true
if [ -n "$have" ] && [ "$have" = "\${want:-$ref}" ]; then
  echo "git source: $(git rev-parse --short HEAD) cached"
elif git fetch -q --depth 1 "$GIT_URL" "$ref"; then
  git checkout -q -f --detach FETCH_HEAD
  git -c gc.pruneExpire=now gc --auto -q
  echo "git source: $(git rev-parse --short HEAD)"
elif [ -n "$have" ]; then
  echo "git source: fetch failed, keeping $(git rev-parse --short HEAD)"
else
  echo "git source: fetch failed" >&2
  exit 1
fi
git checkout -q -f --detach HEAD`;

type EnvVar = { name: string; value?: string; valueFrom?: { secretKeyRef?: { name?: string; key?: string } } };

export function gitSourceContainer(source: GitSource): Record<string, unknown> {
  const env: EnvVar[] = [{ name: "GIT_URL", value: source.url.trim() }];
  if (source.ref.trim()) env.push({ name: "GIT_REF", value: source.ref.trim() });
  if (source.secretName.trim()) env.push({ name: "GIT_CREDENTIAL", valueFrom: { secretKeyRef: { name: source.secretName.trim(), key: source.secretKey.trim() || "token" } } });
  return {
    name: GIT_SOURCE_CONTAINER,
    image: GIT_SOURCE_IMAGE,
    command: ["sh", "-c", script],
    env,
    volumeMounts: [{ name: "data", mountPath: "/target" }],
  };
}

const isGitSource = (item: Record<string, unknown>) => item.name === GIT_SOURCE_CONTAINER;

function parse(container: Record<string, unknown>): GitSource {
  const env = (container.env as EnvVar[] | undefined) ?? [];
  const value = (name: string) => env.find((item) => item.name === name);
  const credential = value("GIT_CREDENTIAL")?.valueFrom?.secretKeyRef;
  return {
    url: value("GIT_URL")?.value ?? "",
    ref: value("GIT_REF")?.value ?? "",
    secretName: credential?.name ?? "",
    secretKey: credential?.key ?? "",
  };
}

function normalized(source: GitSource): string {
  const secretName = source.secretName.trim();
  return JSON.stringify([source.url.trim(), source.ref.trim(), secretName, secretName ? source.secretKey.trim() || "token" : ""]);
}

export function gitSourceOf(initContainers: Record<string, unknown>[] | undefined): GitSource | undefined {
  const container = initContainers?.find(isGitSource);
  return container && parse(container);
}

export function withGitSource(initContainers: Record<string, unknown>[] | undefined, source: GitSource | undefined): Record<string, unknown>[] | undefined {
  const existing = initContainers?.find(isGitSource);
  const rest = (initContainers ?? []).filter((item) => !isGitSource(item));
  if (!source?.url.trim()) return rest.length ? rest : undefined;
  const keep = existing && normalized(parse(existing)) === normalized(source);
  return [keep ? existing : gitSourceContainer(source), ...rest];
}

export function validGitUrl(url: string): boolean {
  return /^(https:\/\/[^\s]+|ssh:\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+)$/.test(url.trim());
}
