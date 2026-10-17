import type { ComponentType } from "react";
import { Link } from "@tanstack/react-router";
import {
  Archive,
  Bell,
  Boxes,
  Cog,
  Info,
  Key,
  Palette,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Activity,
} from "lucide-react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { cn } from "@/lib/utils";
import { useOptionalIntl } from "@/lib/i18n/format";

// SettingsNav is the settings sub-navigation shared by the admin settings
// page (/admin) and the per-user theme settings page (/settings/theme), per
// the Screen/Theme Settings design (assets/design-export lWvcv): one item per
// settings area, "Theme" sitting between "General" and "Authentication".
// Admin settings sections are in-page state (not routes), so ordinary
// entries report their key through onSelect; only "Theme" is a real route
// and renders as a router Link. On /settings/theme the nav is rendered with
// active="theme" and the remaining entries navigate back to /admin (whose
// default section is General).

export type SettingsNavKey =
  | "general"
  | "theme"
  | "auth"
  | "backups"
  | "modules"
  | "modRegistries"
  | "ai"
  | "notifications"
  | "telemetry"
  | "updates"
  | "about";

// Section keys handled by the admin settings page itself (every key except
// the theme page's own "theme").
export type SettingsSectionKey = Exclude<SettingsNavKey, "theme">;

const navMessages = defineMessages({
  general: { id: "web.components.ui.settings_nav.general", defaultMessage: "General", description: "Settings nav: label of the General settings section" },
  theme: { id: "web.components.ui.settings_nav.theme", defaultMessage: "Theme", description: "Settings nav: label of the Theme settings page" },
  auth: { id: "web.components.ui.settings_nav.authentication", defaultMessage: "Authentication", description: "Settings nav: label of the Authentication settings section" },
  backups: { id: "web.components.ui.settings_nav.backup_destinations", defaultMessage: "Backup destinations", description: "Settings nav: label of the Backup destinations settings section" },
  modules: { id: "web.components.ui.settings_nav.module_sources", defaultMessage: "Module sources", description: "Settings nav: label of the Module sources settings section" },
  modRegistries: { id: "web.components.ui.settings_nav.mod_registries", defaultMessage: "Mod registries", description: "Settings nav: label of the Mod registries settings section" },
  ai: { id: "web.components.ui.settings_nav.ai_assistant", defaultMessage: "AI assistant", description: "Settings nav: label of the AI assistant settings section" },
  notifications: { id: "web.components.ui.settings_nav.notifications", defaultMessage: "Notifications", description: "Settings nav: label of the Notifications settings section" },
  telemetry: { id: "web.components.ui.settings_nav.telemetry", defaultMessage: "Telemetry", description: "Settings nav: label of the Telemetry settings section" },
  updates: { id: "web.components.ui.settings_nav.updates", defaultMessage: "Updates", description: "Settings nav: label of the Updates settings section" },
  about: { id: "web.components.ui.settings_nav.about", defaultMessage: "About", description: "Settings nav: label of the About settings section" },
});

const navItems: Array<{ key: SettingsNavKey; label: MessageDescriptor; icon: ComponentType<{ className?: string }> }> = [
  { key: "general",       label: navMessages.general,       icon: Cog },
  { key: "theme",         label: navMessages.theme,         icon: Palette },
  { key: "auth",          label: navMessages.auth,          icon: ShieldCheck },
  { key: "backups",       label: navMessages.backups,       icon: Archive },
  { key: "modules",       label: navMessages.modules,       icon: Boxes },
  { key: "modRegistries", label: navMessages.modRegistries, icon: Key },
  { key: "ai",            label: navMessages.ai,            icon: Sparkles },
  { key: "notifications", label: navMessages.notifications, icon: Bell },
  { key: "telemetry",     label: navMessages.telemetry,     icon: Activity },
  { key: "updates",       label: navMessages.updates,       icon: RefreshCcw },
  { key: "about",         label: navMessages.about,         icon: Info },
];

const itemClass = (active: boolean) =>
  cn(
    "flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors lg:w-full",
    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent",
    active ? "bg-accent/10 font-medium text-accent" : "text-muted hover:bg-foreground/5 hover:text-foreground",
  );

export function SettingsNav({
  active,
  onSelect,
  showAdminSections,
}: {
  active: SettingsNavKey;
  onSelect: (key: SettingsSectionKey) => void;
  /** false hides every admin section (they need config:manage), leaving only Theme. */
  showAdminSections: boolean;
}) {
  const intl = useOptionalIntl();
  const items = showAdminSections ? navItems : navItems.filter((i) => i.key === "theme");
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 scrollbar-thin lg:sticky lg:top-6 lg:mx-0 lg:block lg:space-y-0.5 lg:self-start lg:overflow-visible lg:px-0 lg:pb-0" aria-label={intl.formatMessage({ id: "web.components.ui.settings_nav.settings_sections", defaultMessage: "Settings sections", description: "Settings navigation: screen-reader name of the list of settings sections; not visible on screen" })}>
      {items.map(({ key, label, icon: Icon }) =>
        key === "theme" ? (
          <Link key={key} to="/settings/theme" className={itemClass(active === key)} aria-current={active === key ? "page" : undefined}>
            <Icon className="h-4 w-4 shrink-0" />
            <span>{intl.formatMessage(label)}</span>
          </Link>
        ) : (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            aria-current={active === key ? "page" : undefined}
            className={itemClass(active === key)}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span>{intl.formatMessage(label)}</span>
          </button>
        ),
      )}
    </nav>
  );
}
