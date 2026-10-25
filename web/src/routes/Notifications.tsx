import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { Check } from "lucide-react";
import { defineMessages, type MessageDescriptor } from "react-intl";
import { PageHeader } from "@/components/ui/PageHeader";
import { useNotifications } from "@/components/ui/NotificationsPanel";
import { useFormat, useOptionalIntl } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

const verbMessage: MessageDescriptor = defineMessages({
  verb: {
    id: "web.routes.notifications.verb",
    defaultMessage: "{verb, select, added {added} modified {modified} deleted {deleted} other {{verb}}}",
    description: "Notifications: colored pill naming what happened to an object; {verb} is the lower-cased event type (added, modified or deleted, otherwise the raw type)",
  },
}).verb;

function verbTone(verb: string): string {
  if (verb === "added") return "bg-success/10 text-success";
  if (verb === "deleted") return "bg-danger/10 text-danger";
  return "bg-primary/10 text-primary";
}

export function NotificationsPage() {
  const intl = useOptionalIntl();
  const fmt = useFormat();
  const { notices, unread, markAllRead, clear } = useNotifications();
  const [unreadAtOpen] = useState(() => unread);
  const [noticesAtOpen] = useState(() => notices.length);
  const arrivedSinceOpen = Math.max(0, notices.length - noticesAtOpen);

  useEffect(() => {
    if (unread > 0) markAllRead();
  }, [unread, markAllRead]);

  const isUnread = (index: number): boolean =>
    index >= arrivedSinceOpen && index < arrivedSinceOpen + unreadAtOpen;

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title={intl.formatMessage({ id: "web.routes.notifications.notifications", defaultMessage: "Notifications", description: "Notifications: page title at the top of the notifications screen; keep it short" })}
        description={intl.formatMessage({ id: "web.routes.notifications.live_cluster_events", defaultMessage: "Live cluster events: servers, backups and templates added, changed or removed.", description: "Notifications: description under the title saying the page lists live cluster events for servers, backups and templates" })}
        actions={
          <>
            <Button variant="outline" size="sm" isDisabled={unread === 0} onPress={markAllRead}>
              <Check className="h-4 w-4" /> {intl.formatMessage({ id: "web.routes.notifications.mark_all_read", defaultMessage: "Mark all read", description: "Notifications: button that marks every notification as read; keep it short" })}
            </Button>
            <Button variant="ghost" size="sm" isDisabled={notices.length === 0} onPress={clear}>
              {intl.formatMessage({ id: "web.routes.notifications.clear", defaultMessage: "Clear", description: "Notifications: button that removes every notification from the list; keep it short" })}
            </Button>
          </>
        }
      />

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        {notices.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted">
            {intl.formatMessage({ id: "web.routes.notifications.no_notifications_yet", defaultMessage: "No notifications yet.", description: "Notifications: empty state shown when no cluster events have arrived yet" })}
          </div>
        ) : (
          <ul>
            {notices.map((notice, index) => (
              <li
                key={notice.id}
                className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", isUnread(index) && "bg-primary")} />
                  <span className={cn("w-[72px] shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] font-medium", verbTone(notice.verb))}>
                    {intl.formatMessage(verbMessage, { verb: notice.verb })}
                  </span>
                  <span className="hidden text-sm text-muted sm:inline">{notice.kind}</span>
                  <span className="truncate font-mono text-sm font-medium text-foreground">{notice.name}</span>
                </div>
                <time dateTime={notice.at} className="shrink-0 font-mono text-xs text-muted">
                  {fmt.time(new Date(notice.at))}
                </time>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
