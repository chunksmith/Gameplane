import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useQueryClient, type QueryFilters } from "@tanstack/react-query";
import { openEventStream, queryFilterForKind, type GameplaneEvent } from "@/lib/sse";

export interface Notice {
  id: number;
  verb: string;
  kind: string;
  name: string;
  at: string;
}

export interface NotificationFeed {
  notices: Notice[];
  unread: number;
  markAllRead: () => void;
  clear: () => void;
}

// Window for coalescing SSE-driven cache invalidations per query key.
const INVALIDATE_COALESCE_MS = 500;

// phaseOf reads status.phase off a watch object ("" when absent).
function phaseOf(obj: GameplaneEvent["object"] | undefined): string {
  const status = obj?.status as { phase?: unknown } | undefined;
  return typeof status?.phase === "string" ? status.phase : "";
}

export function useNotificationFeed(enabled: boolean): NotificationFeed {
  const qc = useQueryClient();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let seq = 0;
    // Coalesce invalidations per query key: a burst of watch events for one
    // kind costs a single refetch. An in-flight fetch is never cancelled (a
    // steady event stream would starve it), but it may predate the event, so
    // the invalidation waits for it to settle and then refetches.
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    const flush = (id: string, filters: QueryFilters) => {
      if (qc.isFetching(filters) > 0) {
        pending.set(id, setTimeout(() => flush(id, filters), INVALIDATE_COALESCE_MS));
        return;
      }
      pending.delete(id);
      void qc.invalidateQueries(filters, { cancelRefetch: false });
    };
    // Agent heartbeats patch status.agent every ~20 s per server, which
    // arrives as MODIFIED with no spec or phase change. Remember each
    // object's (generation, phase) signature and drop a MODIFIED that leaves
    // it unchanged: it neither notifies nor invalidates (the pollers cover
    // heartbeat-only fields). ADDED and DELETED always pass.
    const seen = new Map<string, string>();
    const isMeaningful = (ev: GameplaneEvent): boolean => {
      const meta = ev.object?.metadata;
      const key = `${ev.kind}/${meta?.namespace ?? ""}/${meta?.name ?? ""}`;
      if (ev.eventType === "DELETED") {
        seen.delete(key);
        return true;
      }
      const sig = `${meta?.generation ?? ""}/${phaseOf(ev.object)}`;
      const prev = seen.get(key);
      seen.set(key, sig);
      return ev.eventType !== "MODIFIED" || prev !== sig;
    };
    const dispose = openEventStream({
      onEvent: (ev: GameplaneEvent) => {
        if (!isMeaningful(ev)) return;
        const filters = queryFilterForKind(ev.kind);
        if (filters) {
          const id = ev.kind;
          if (!pending.has(id)) {
            pending.set(id, setTimeout(() => flush(id, filters), INVALIDATE_COALESCE_MS));
          }
        }
        seq += 1;
        const notice: Notice = {
          id: seq,
          verb: ev.eventType.toLowerCase(),
          kind: ev.kind.replace(/s$/, ""),
          name: ev.object?.metadata?.name ?? "",
          at: new Date().toISOString(),
        };
        setNotices((prev) => [notice, ...prev].slice(0, 50));
        setUnread((u) => u + 1);
      },
    });
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      dispose();
    };
  }, [qc, enabled]);

  const markAllRead = useCallback(() => setUnread(0), []);
  const clear = useCallback(() => {
    setNotices([]);
    setUnread(0);
  }, []);

  return { notices, unread, markAllRead, clear };
}

export const NotificationsContext = createContext<NotificationFeed>({
  notices: [],
  unread: 0,
  markAllRead: () => {},
  clear: () => {},
});

export function useNotifications(): NotificationFeed {
  return useContext(NotificationsContext);
}
