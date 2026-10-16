import { PageHeader } from "@/components/ui/PageHeader";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";

export function AssistantPage() {
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Assistant"
        description="Ask Claude to change servers, files, plugins and backups. Every action runs with your own permissions."
      />
      <AssistantPanel />
    </div>
  );
}
