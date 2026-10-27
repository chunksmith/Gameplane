import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Input, Label, TextField } from "@heroui/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { SettingsNav } from "@/components/ui/SettingsNav";
import { LinearLogo } from "@/components/assistant/LinearLogo";
import { GitHubCard } from "@/components/settings/GitHubCard";
import { Assistant } from "@/lib/assistant";
import { can, useMe } from "@/lib/auth";
import { errorTextIntl } from "@/lib/errors";
import { useOptionalIntl } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

const LINEAR_KEY_PLACEHOLDER = "lin_api_…";

export function IntegrationsSettingsPage() {
  const intl = useOptionalIntl();
  const { data: me } = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const linear = useQuery({ queryKey: ["ai", "linear"], queryFn: Assistant.linear });
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const done = () => {
    setApiKey("");
    setEditing(false);
    void qc.invalidateQueries({ queryKey: ["ai"] });
  };
  const save = useMutation({ mutationFn: () => Assistant.putLinearKey(apiKey.trim()), onSuccess: done });
  const remove = useMutation({ mutationFn: Assistant.deleteLinearKey, onSuccess: done });
  const error = save.error ?? remove.error;
  const access = linear.data;

  const permissions = access && [
    { allowed: true, label: intl.formatMessage({ id: "web.routes.integrations.linear_read", defaultMessage: "Read issues, projects and comments", description: "Integrations settings: what the assistant may do in Linear; reading is always allowed" }), hint: intl.formatMessage({ id: "web.routes.integrations.linear_read_hint", defaultMessage: "Set by your admin. Reads run without asking.", description: "Integrations settings: hint under the Linear read permission" }) },
    { allowed: access.comment, label: intl.formatMessage({ id: "web.routes.integrations.linear_comment", defaultMessage: "Post comments", description: "Integrations settings: Linear permission that lets the assistant post comments" }), hint: access.comment ? intl.formatMessage({ id: "web.routes.integrations.linear_asks_first", defaultMessage: "Set by your admin. The assistant asks you first.", description: "Integrations settings: hint under an allowed Linear change; the assistant waits for the user's approval" }) : intl.formatMessage({ id: "web.routes.integrations.linear_off_by_admin", defaultMessage: "Turned off by your admin.", description: "Integrations settings: hint under a Linear permission the admin has turned off" }) },
    { allowed: access.write, label: intl.formatMessage({ id: "web.routes.integrations.linear_write", defaultMessage: "Create and change issues", description: "Integrations settings: Linear permission that lets the assistant create and change issues" }), hint: access.write ? intl.formatMessage({ id: "web.routes.integrations.linear_asks_first", defaultMessage: "Set by your admin. The assistant asks you first.", description: "Integrations settings: hint under an allowed Linear change; the assistant waits for the user's approval" }) : intl.formatMessage({ id: "web.routes.integrations.linear_off_by_admin", defaultMessage: "Turned off by your admin.", description: "Integrations settings: hint under a Linear permission the admin has turned off" }) },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={intl.formatMessage({ id: "web.routes.integrations.title", defaultMessage: "Integrations", description: "Integrations settings: page title" })}
        description={intl.formatMessage({ id: "web.routes.integrations.description", defaultMessage: "Connect your own accounts to the assistant.", description: "Integrations settings: description under the page title" })}
      />
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <SettingsNav
          active="integrations"
          showAdminSections={can(me, "config:manage")}
          onSelect={(key) => void navigate({ to: "/admin", search: { section: key } })}
        />
        <div className="space-y-6">
        <Card>
          <Card.Content className="divide-y divide-border">
            <div className="flex flex-wrap items-center gap-3 pb-3.5">
              <LinearLogo className="h-9 w-9" />
              <div className="min-w-48 flex-1">
                <div className="text-sm font-semibold">{intl.formatMessage({ id: "web.routes.integrations.linear", defaultMessage: "Linear", description: "Integrations settings: title of the Linear card; a product name, usually left untranslated" })}</div>
                <div className="text-xs text-muted">{intl.formatMessage({ id: "web.routes.integrations.linear_subtitle", defaultMessage: "Connect your Linear account. When you type @linear, the assistant reads and updates Linear as you, with your own API key.", description: "Integrations settings: subtitle of the Linear card" })}</div>
              </div>
              {access?.keySet && (
                <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-1 text-xs text-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  {intl.formatMessage({ id: "web.routes.integrations.linear_connected", defaultMessage: "Connected", description: "Integrations settings: badge on the Linear card once the user's API key is stored" })}
                </span>
              )}
            </div>
            {access && !access.enabled ? (
              <div className="pt-3.5 text-xs text-muted">{intl.formatMessage({ id: "web.routes.integrations.linear_disabled", defaultMessage: "Your admin has not turned on Linear for the assistant.", description: "Integrations settings: shown in the Linear card while the admin has Linear turned off" })}</div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3 py-3.5">
                  <div className="min-w-48 flex-1">
                    <div className="text-sm font-medium">{intl.formatMessage({ id: "web.routes.integrations.linear_key", defaultMessage: "Personal API key", description: "Integrations settings: label of the user's Linear API key row" })}</div>
                    <div className="text-xs text-muted">{intl.formatMessage({ id: "web.routes.integrations.linear_key_hint", defaultMessage: "Create one in Linear under Settings → Security & access. Only you can use it.", description: "Integrations settings: hint under the Linear API key row; where to create the key and that only this user's assistant chats use it" })}</div>
                  </div>
                  {!editing && access?.keySet && (
                    <span className="font-mono text-xs text-muted">{intl.formatMessage({ id: "web.routes.integrations.linear_key_masked", defaultMessage: "lin_api_••••••••{hint}", description: "Integrations settings: the stored Linear API key, masked except its last four characters" }, { hint: access.keyHint })}</span>
                  )}
                  {!editing && (
                    <Button variant="secondary" size="sm" onPress={() => setEditing(true)}>
                      {access?.keySet ? intl.formatMessage({ id: "web.routes.integrations.linear_replace", defaultMessage: "Replace", description: "Integrations settings: button that replaces the stored Linear API key" }) : intl.formatMessage({ id: "web.routes.integrations.linear_connect", defaultMessage: "Add API key", description: "Integrations settings: button that opens the form to add a Linear API key" })}
                    </Button>
                  )}
                  {!editing && access?.keySet && (
                    <Button variant="danger" size="sm" isPending={remove.isPending} onPress={() => remove.mutate()}>{intl.formatMessage({ id: "web.routes.integrations.linear_remove", defaultMessage: "Remove", description: "Integrations settings: button that deletes the stored Linear API key" })}</Button>
                  )}
                  {editing && (
                    <div className="w-full space-y-3">
                      <TextField className="space-y-1.5">
                        <Label className="text-xs">{intl.formatMessage({ id: "web.routes.integrations.linear_key_field", defaultMessage: "Linear API key", description: "Integrations settings: label of the field where the user pastes their Linear API key" })}</Label>
                        <Input type="password" autoFocus value={apiKey} placeholder={LINEAR_KEY_PLACEHOLDER} onChange={(e) => setApiKey(e.target.value)} spellCheck={false} />
                      </TextField>
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" onPress={() => setEditing(false)}>{intl.formatMessage({ id: "web.routes.integrations.cancel", defaultMessage: "Cancel", description: "Integrations settings: button that closes the Linear API key form" })}</Button>
                        <Button isDisabled={apiKey.trim() === ""} isPending={save.isPending} onPress={() => save.mutate()}>{intl.formatMessage({ id: "web.routes.integrations.save_key", defaultMessage: "Save key", description: "Integrations settings: button that stores the Linear API key entered in the form" })}</Button>
                      </div>
                    </div>
                  )}
                  {error && <div className="w-full text-xs text-danger">{errorTextIntl(intl, error)}</div>}
                </div>
                {permissions?.map((permission) => (
                  <div key={permission.label} className="flex items-center justify-between gap-4 py-3.5 last:pb-0">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{permission.label}</div>
                      <div className="text-xs text-muted">{permission.hint}</div>
                    </div>
                    <span className={cn("shrink-0 text-xs font-medium", permission.allowed ? "text-success" : "text-muted")}>
                      {permission.allowed ? intl.formatMessage({ id: "web.routes.integrations.allowed", defaultMessage: "Allowed", description: "Integrations settings: status of a Linear permission the admin allows" }) : intl.formatMessage({ id: "web.routes.integrations.off", defaultMessage: "Off", description: "Integrations settings: status of a Linear permission the admin has turned off" })}
                    </span>
                  </div>
                ))}
              </>
            )}
          </Card.Content>
        </Card>
        <GitHubCard />
        </div>
      </div>
    </div>
  );
}
