import { Input } from "@heroui/react";
import { useOptionalIntl } from "@/lib/i18n/format";
import type { GitSource } from "@/lib/gitSource";

export function GitSourceFields({ enabled, source, onToggle, onChange }: {
  enabled: boolean;
  source: GitSource;
  onToggle: (enabled: boolean) => void;
  onChange: (source: GitSource) => void;
}) {
  const intl = useOptionalIntl();
  const field = (key: keyof GitSource, label: string, placeholder: string) => (
    <div className="space-y-1.5">
      <label htmlFor={`git-${key}`} className="block text-xs text-muted">{label}</label>
      <Input id={`git-${key}`} value={source[key]} placeholder={placeholder} onChange={(event) => onChange({ ...source, [key]: event.target.value })} />
    </div>
  );
  return (
    <div className="space-y-3">
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(event) => onToggle(event.target.checked)} />
        {intl.formatMessage({ id: "web.components.git_source.enable", defaultMessage: "Clone server files from a Git repository", description: "Git source fields: checkbox label that clones the server files from a Git repository into the data volume before every start" })}
      </label>
      {enabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          {field("url", intl.formatMessage({ id: "web.components.git_source.url", defaultMessage: "Repository URL", description: "Git source fields: field label for the Git repository URL" }), intl.formatMessage({ id: "web.components.git_source.url_placeholder", defaultMessage: "https://github.com/org/server.git", description: "Git source fields: example repository URL shown inside the empty URL field; a sample value, keep it as written" }))}
          {field("ref", intl.formatMessage({ id: "web.components.git_source.ref", defaultMessage: "Branch or tag (optional)", description: "Git source fields: field label for the branch, tag or commit to clone; empty uses the default branch" }), intl.formatMessage({ id: "web.components.git_source.ref_placeholder", defaultMessage: "main", description: "Git source fields: example branch name shown inside the empty branch field; a sample value, keep it as written" }))}
          {field("secretName", intl.formatMessage({ id: "web.components.git_source.secret", defaultMessage: "Credentials Secret (optional)", description: "Git source fields: field label for the name of a Kubernetes Secret in the server's namespace holding a token or deploy key" }), intl.formatMessage({ id: "web.components.git_source.secret_placeholder", defaultMessage: "repo-credentials", description: "Git source fields: example Secret name shown inside the empty Secret field; a sample value, keep it as written" }))}
          {field("secretKey", intl.formatMessage({ id: "web.components.git_source.secret_key", defaultMessage: "Secret key", description: "Git source fields: field label for the key inside the credentials Secret; empty means token" }), intl.formatMessage({ id: "web.components.git_source.secret_key_placeholder", defaultMessage: "token", description: "Git source fields: default Secret key shown inside the empty key field; keep it as written" }))}
          <span className="block text-[11px] text-muted sm:col-span-2">{intl.formatMessage({ id: "web.components.git_source.hint", defaultMessage: "Checked out onto the data volume before every start; an unchanged commit is not downloaded again. The Secret holds a token for HTTPS or a deploy key for SSH. Requires admin.", description: "Git source fields: hint under the Git fields explaining when the repository is cloned, that an unchanged commit is reused, what the Secret holds and that admin is required" })}</span>
        </div>
      )}
    </div>
  );
}
