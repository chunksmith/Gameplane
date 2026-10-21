import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery } from "@/test/render";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";

let sseCallback: ((ev: unknown) => void) | null = null;

vi.mock("@/lib/sse", () => ({
  openEventStream: (opts: { onEvent: (ev: unknown) => void }) => {
    sseCallback = opts.onEvent;
    return () => {
      sseCallback = null;
    };
  },
  queryFilterForKind: (kind: string) => {
    const keyMap: Record<string, string[] | null> = {
      servers: ["servers"],
      templates: ["templates"],
      backups: ["backups"],
      schedules: ["schedules"],
      restores: ["restores"],
    };
    const key = keyMap[kind];
    return key ? { queryKey: key } : null;
  },
}));

import { useNotificationFeed, type NotificationFeed } from "./NotificationsPanel";

let latest: NotificationFeed | undefined;

function Harness({ enabled = true }: { enabled?: boolean }) {
  const feed = useNotificationFeed(enabled);
  useEffect(() => {
    latest = feed;
  });
  return (
    <>
      <output aria-label="unread">{feed.unread}</output>
      <ul>
        {feed.notices.map((n) => (
          <li key={n.id}>{`${n.verb} ${n.kind} ${n.name}`}</li>
        ))}
      </ul>
      <button onClick={feed.markAllRead}>mark</button>
      <button onClick={feed.clear}>clear</button>
    </>
  );
}

const send = async (eventType: string, kind: string, name: string) => {
  await act(() => {
    sseCallback!({ kind, eventType, object: { metadata: { name } } });
  });
};

describe("useNotificationFeed", () => {
  beforeEach(() => {
    sseCallback = null;
    latest = undefined;
  });

  it("closes its subscription when local event streaming is disabled", () => {
    const view = renderWithQuery(<Harness />);
    expect(sseCallback).not.toBeNull();
    view.rerender(<QueryClientProvider client={view.client}><Harness enabled={false} /></QueryClientProvider>);
    expect(sseCallback).toBeNull();
  });

  it("starts with no notices and no unread items", () => {
    renderWithQuery(<Harness />);
    expect(latest!.notices).toEqual([]);
    expect(screen.getByLabelText("unread")).toHaveTextContent("0");
  });

  it("stores structured notices with verb, kind and name", async () => {
    renderWithQuery(<Harness />);
    await send("ADDED", "servers", "test-server");
    expect(latest!.notices).toEqual([
      { id: 1, verb: "added", kind: "server", name: "test-server", at: expect.any(String) },
    ]);
  });

  it("lower-cases the event type and strips the trailing s from the kind", async () => {
    renderWithQuery(<Harness />);
    await send("MODIFIED", "servers", "my-server");
    await send("DELETED", "backups", "b-1");
    expect(latest!.notices.map((n) => [n.verb, n.kind, n.name])).toEqual([
      ["deleted", "backup", "b-1"],
      ["modified", "server", "my-server"],
    ]);
  });

  it("stamps each notice with an ISO timestamp", async () => {
    renderWithQuery(<Harness />);
    await send("ADDED", "servers", "s");
    expect(new Date(latest!.notices[0].at).toISOString()).toBe(latest!.notices[0].at);
  });

  it("counts unread notices", async () => {
    renderWithQuery(<Harness />);
    await send("ADDED", "servers", "server-1");
    await send("MODIFIED", "backups", "backup-1");
    expect(screen.getByLabelText("unread")).toHaveTextContent("2");
  });

  it("markAllRead resets unread to 0 and keeps the notices", async () => {
    renderWithQuery(<Harness />);
    await send("ADDED", "servers", "server-1");
    await userEvent.click(screen.getByRole("button", { name: "mark" }));
    expect(screen.getByLabelText("unread")).toHaveTextContent("0");
    expect(latest!.notices).toHaveLength(1);
  });

  it("clear empties the notices and resets unread", async () => {
    renderWithQuery(<Harness />);
    await send("ADDED", "servers", "server-1");
    await send("ADDED", "servers", "server-2");
    await userEvent.click(screen.getByRole("button", { name: "clear" }));
    expect(latest!.notices).toEqual([]);
    expect(screen.getByLabelText("unread")).toHaveTextContent("0");
  });

  it("caps notices at 50 items", async () => {
    renderWithQuery(<Harness />);
    for (let i = 1; i <= 60; i++) {
      await send("ADDED", "servers", `server-${i}`);
    }
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
    expect(latest!.notices[0].name).toBe("server-60");
  });

  it("coalesces a burst of events for one kind into a single invalidation", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { client } = renderWithQuery(<Harness />);
      const spy = vi.spyOn(client, "invalidateQueries");
      for (let i = 1; i <= 30; i++) {
        await act(() => {
          sseCallback!({ kind: "templates", eventType: "MODIFIED", object: { metadata: { name: `t-${i}` } } });
        });
      }
      await act(() => {
        sseCallback!({ kind: "servers", eventType: "MODIFIED", object: { metadata: { name: "s-1" } } });
      });
      expect(spy).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledWith({ queryKey: ["templates"] }, { cancelRefetch: false });
      expect(spy).toHaveBeenCalledWith({ queryKey: ["servers"] }, { cancelRefetch: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers the invalidation until an in-flight fetch for that key settles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { client } = renderWithQuery(<Harness />);
      const spy = vi.spyOn(client, "invalidateQueries");
      const fetching = vi.spyOn(client, "isFetching").mockReturnValueOnce(1).mockReturnValue(0);
      await act(() => {
        sseCallback!({ kind: "servers", eventType: "MODIFIED", object: { metadata: { name: "s-1" } } });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(fetching).toHaveBeenCalledWith({ queryKey: ["servers"] });
      expect(spy).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ queryKey: ["servers"] }, { cancelRefetch: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops pending invalidations on unmount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { client, unmount } = renderWithQuery(<Harness />);
      const spy = vi.spyOn(client, "invalidateQueries");
      await act(() => {
        sseCallback!({ kind: "servers", eventType: "MODIFIED", object: { metadata: { name: "s-1" } } });
      });
      unmount();
      await vi.advanceTimersByTimeAsync(500);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("heartbeat noise filter", () => {
    const sendObject = async (eventType: string, object?: Record<string, unknown>) => {
      await act(() => {
        sseCallback!({ kind: "servers", eventType, object });
      });
    };
    const server = (generation: number, phase: string) => ({
      metadata: { name: "s1", namespace: "games", generation },
      status: { phase },
    });
    const noticeCount = () => screen.queryAllByRole("listitem").length;

    it("drops MODIFIED events that change neither generation nor phase", async () => {
      renderWithQuery(<Harness />);
      await sendObject("ADDED", server(1, "Running"));
      await sendObject("MODIFIED", server(1, "Running"));
      await sendObject("MODIFIED", server(1, "Running"));
      await sendObject("MODIFIED", server(1, "Running"));
      expect(noticeCount()).toBe(1);
      expect(screen.getByText("added server s1")).toBeInTheDocument();
    });

    it("records a MODIFIED when the phase changes", async () => {
      renderWithQuery(<Harness />);
      await sendObject("ADDED", server(1, "Running"));
      await sendObject("MODIFIED", server(1, "Stopped"));
      await sendObject("MODIFIED", server(1, "Stopped"));
      expect(noticeCount()).toBe(2);
      expect(screen.getByText("modified server s1")).toBeInTheDocument();
    });

    it("records a MODIFIED when the generation (spec) changes", async () => {
      renderWithQuery(<Harness />);
      await sendObject("ADDED", server(1, "Running"));
      await sendObject("MODIFIED", server(2, "Running"));
      expect(noticeCount()).toBe(2);
    });

    it("records the first MODIFIED of an unseen object once, even without generation or status", async () => {
      renderWithQuery(<Harness />);
      await sendObject("MODIFIED", { metadata: { name: "bare" } });
      await sendObject("MODIFIED", { metadata: { name: "bare" } });
      await sendObject("MODIFIED", { metadata: { name: "bare" } });
      await sendObject("MODIFIED");
      expect(noticeCount()).toBe(2);
    });

    it("forgets the baseline on DELETED so a later MODIFIED is recorded", async () => {
      renderWithQuery(<Harness />);
      await sendObject("ADDED", server(1, "Running"));
      await sendObject("DELETED", server(1, "Running"));
      await sendObject("MODIFIED", server(1, "Running"));
      expect(noticeCount()).toBe(3);
    });

    it("does not invalidate caches for a suppressed MODIFIED", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { client } = renderWithQuery(<Harness />);
        const spy = vi.spyOn(client, "invalidateQueries");
        await sendObject("ADDED", server(1, "Running"));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });
        expect(spy).toHaveBeenCalledTimes(1);
        await sendObject("MODIFIED", server(1, "Running"));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
