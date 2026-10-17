import { PageHeader } from "@/components/ui/PageHeader";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { useOptionalIntl } from "@/lib/i18n/format";

export function AssistantPage() {
  const intl = useOptionalIntl();
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <PageHeader
        title={intl.formatMessage({ id: "web.routes.assistant.assistant", defaultMessage: "Assistant", description: "Assistant: page title at the top of the AI assistant screen; keep it short" })}
        description={intl.formatMessage({ id: "web.routes.assistant.ask_claude_to_change_servers_files", defaultMessage: "Ask Claude to change servers, files, plugins and backups. Every action runs with your own permissions.", description: "Assistant: description under the page title, saying what the assistant can change and that it uses the user's own permissions" })}
      />
      <AssistantPanel />
    </div>
  );
}
