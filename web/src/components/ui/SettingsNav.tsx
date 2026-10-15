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
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
  | "notifications"
  | "telemetry"
  | "updates"
  | "about";

// Section keys handled by the admin settings page itself (every key except
// the theme page's own "theme").
export type SettingsSectionKey = Exclude<SettingsNavKey, "theme">;

const navItems: Array<{ key: SettingsNavKey; label: string; icon: ComponentType<{ className?: string }> }> = [
  { key: "general",       label: "General",             icon: Cog },
  { key: "theme",         label: "Theme",               icon: Palette },
  { key: "auth",          label: "Authentication",      icon: ShieldCheck },
  { key: "backups",       label: "Backup destinations", icon: Archive },
  { key: "modules",       label: "Module sources",      icon: Boxes },
  { key: "modRegistries", label: "Mod registries",      icon: Key },
  { key: "notifications", label: "Notifications",       icon: Bell },
  { key: "telemetry",     label: "Telemetry",           icon: Activity },
  { key: "updates",       label: "Updates",             icon: RefreshCcw },
  { key: "about",         label: "About",               icon: Info },
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
  const items = showAdminSections ? navItems : navItems.filter((i) => i.key === "theme");
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 scrollbar-thin lg:sticky lg:top-6 lg:mx-0 lg:block lg:space-y-0.5 lg:self-start lg:overflow-visible lg:px-0 lg:pb-0" aria-label="Settings sections">
      {items.map(({ key, label, icon: Icon }) =>
        key === "theme" ? (
          <Link key={key} to="/settings/theme" className={itemClass(active === key)} aria-current={active === key ? "page" : undefined}>
            <Icon className="h-4 w-4 shrink-0" />
            <span>{label}</span>
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
            <span>{label}</span>
          </button>
        ),
      )}
    </nav>
  );
}
