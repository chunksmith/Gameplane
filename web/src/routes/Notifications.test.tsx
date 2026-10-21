import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery } from "@/test/render";
import { NotificationsContext, type NotificationFeed } from "@/components/ui/NotificationsPanel";
import { NotificationsPage } from "./Notifications";

const at = "2026-10-21T09:30:00.000Z";

function fakeFeed(overrides: Partial<NotificationFeed> = {}): NotificationFeed {
  return { notices: [], unread: 0, markAllRead: vi.fn(), clear: vi.fn(), ...overrides };
}

function renderPage(feed: NotificationFeed) {
  return renderWithQuery(
    <NotificationsContext.Provider value={feed}>
      <NotificationsPage />
    </NotificationsContext.Provider>,
  );
}

describe("NotificationsPage", () => {
  it("shows the empty state when there are no notifications", () => {
    renderPage(fakeFeed());
    expect(screen.getByText("No notifications yet.")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("renders each notice with its verb, kind and name", () => {
    renderPage(
      fakeFeed({
        notices: [
          { id: 2, verb: "deleted", kind: "backup", name: "nightly-1", at },
          { id: 1, verb: "added", kind: "server", name: "alpha", at },
        ],
      }),
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("deleted");
    expect(items[0]).toHaveTextContent("backup");
    expect(items[0]).toHaveTextContent("nightly-1");
    expect(items[1]).toHaveTextContent("added");
    expect(items[1]).toHaveTextContent("server");
    expect(items[1]).toHaveTextContent("alpha");
  });

  it("marks every notice read on open", () => {
    const feed = fakeFeed({ unread: 2, notices: [{ id: 1, verb: "added", kind: "server", name: "a", at }] });
    renderPage(feed);
    expect(feed.markAllRead).toHaveBeenCalled();
  });

  it("Mark all read calls markAllRead", async () => {
    const feed = fakeFeed({ unread: 1, notices: [{ id: 1, verb: "added", kind: "server", name: "a", at }] });
    renderPage(feed);
    vi.mocked(feed.markAllRead).mockClear();
    await userEvent.click(screen.getByRole("button", { name: /mark all read/i }));
    expect(feed.markAllRead).toHaveBeenCalledTimes(1);
  });

  it("Mark all read is disabled when nothing is unread", () => {
    renderPage(fakeFeed({ notices: [{ id: 1, verb: "added", kind: "server", name: "a", at }] }));
    expect(screen.getByRole("button", { name: /mark all read/i })).toBeDisabled();
  });

  it("Clear calls clear", async () => {
    const feed = fakeFeed({ notices: [{ id: 1, verb: "added", kind: "server", name: "a", at }] });
    renderPage(feed);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(feed.clear).toHaveBeenCalledTimes(1);
  });

  it("Clear is disabled when there are no notifications", () => {
    renderPage(fakeFeed());
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });
});
