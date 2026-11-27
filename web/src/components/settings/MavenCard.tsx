import { Button, Card } from "@heroui/react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { Copy, ExternalLink, Package } from "lucide-react";
import { useFormat, useOptionalIntl } from "@/lib/i18n/format";
import { useMaven } from "@/lib/repositories";
import { cn } from "@/lib/utils";
import { sizeLabel } from "@/routes/repository/buildUi";

const M: Record<string, MessageDescriptor> = defineMessages({
  title: { id: "web.settings.maven.title", defaultMessage: "Maven repository", description: "Integrations settings: title of the Maven card; a product name, usually left untranslated" },
  subtitle: { id: "web.settings.maven.subtitle", defaultMessage: "Gameplane's own Maven store. Builds read it with a read-only token. Publishing is on by default per repository.", description: "Integrations settings: subtitle of the Maven card, explaining the read token and that publishing is on by default" },
  running: { id: "web.settings.maven.running", defaultMessage: "Running", description: "Integrations settings: state of the Maven store when it answers; keep it short" },
  unavailable: { id: "web.settings.maven.unavailable", defaultMessage: "Unavailable", description: "Integrations settings: state of the Maven store when it does not answer; keep it short" },
  url: { id: "web.settings.maven.url", defaultMessage: "Repository URL", description: "Integrations settings: label of the Maven repository URL row" },
  copy: { id: "web.settings.maven.copy", defaultMessage: "Copy", description: "Integrations settings: button that copies the Maven repository URL; keep it short" },
  open_admin: { id: "web.settings.maven.open_admin", defaultMessage: "Open Reposilite", description: "Integrations settings: link that opens the Reposilite admin page; Reposilite is a product name" },
  stored: { id: "web.settings.maven.stored", defaultMessage: "{count, plural, one {# artifact} other {# artifacts}} stored", description: "Integrations settings: number of artifacts in the Maven store; {count} is the number" },
  snippet_title: { id: "web.settings.maven.snippet_title", defaultMessage: "Use it from your machine", description: "Integrations settings: heading of the settings.xml and deploy snippet" },
  snippet_hint: { id: "web.settings.maven.snippet_hint", defaultMessage: "Add this server to ~/.m2/settings.xml with your own Reposilite token, then run mvn deploy.", description: "Integrations settings: hint above the Maven deploy snippet" },
});

export function MavenCard() {
  const intl = useOptionalIntl();
  const format = useFormat();
  const maven = useMaven();
  const data = maven.data;
  if (!data || !data.enabled) return null;
  const url = data.url ?? "";
  const snippet = `# ~/.m2/settings.xml\n<server>\n  <id>gameplane</id>\n  <username>your-username</username>\n  <password>\${env.GAMEPLANE_MAVEN_TOKEN}</password>\n</server>\n\nmvn deploy -DaltDeploymentRepository=gameplane::${url}`;
  const copy = () => void navigator.clipboard.writeText(url);
  const state = data.state === "running" ? M.running : M.unavailable;

  return (
    <Card>
      <Card.Content className="gap-4 divide-y divide-border">
        <div className="flex flex-wrap items-center gap-3 pb-3.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-foreground text-background"><Package className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-48 flex-1">
            <div className="text-sm font-semibold">{intl.formatMessage(M.title)}</div>
            <div className="text-xs text-muted">{intl.formatMessage(M.subtitle)}</div>
          </div>
          <span className={cn("flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs", data.state === "running" ? "bg-success/15 text-success" : "bg-danger/10 text-danger")}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {intl.formatMessage(state)}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 py-3.5">
          <div className="min-w-0">
            <div className="text-sm font-medium">{intl.formatMessage(M.url)}</div>
            <code className="block truncate font-mono text-xs text-muted">{url}</code>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" isDisabled={!url} onPress={copy}>
              <Copy className="h-3.5 w-3.5" />{intl.formatMessage(M.copy)}
            </Button>
            {data.adminUrl && (
              <a href={data.adminUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs hover:bg-default/40">
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />{intl.formatMessage(M.open_admin)}
              </a>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 py-3.5 text-xs text-muted">
          <span>{intl.formatMessage(M.stored, { count: data.artifacts ?? 0 })}</span>
          {data.bytes !== null && <span>{sizeLabel(intl, format, data.bytes)}</span>}
        </div>
        <div className="flex flex-col gap-2 py-3.5">
          <div className="text-sm font-medium">{intl.formatMessage(M.snippet_title)}</div>
          <p className="text-xs text-muted">{intl.formatMessage(M.snippet_hint)}</p>
          <pre className="overflow-x-auto rounded-xl bg-surface-secondary p-3 font-mono text-xs scrollbar-thin">{snippet}</pre>
        </div>
      </Card.Content>
    </Card>
  );
}
