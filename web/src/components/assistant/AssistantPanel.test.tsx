import { describe, it, expect, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeUser } from "@/test/factories";
import type { AssistantConversation, AssistantDetail, AssistantMessage } from "@/lib/assistant";
import { AssistantPanel } from "./AssistantPanel";

const now = new Date().toISOString();

function conv(over: Partial<AssistantConversation> = {}): AssistantConversation {
  return {
    id: "c1", userId: 1, username: "admin", title: "Change the motd", cluster: "local", namespace: "games", server: "lobby",
    model: "claude-opus-5-5", effort: "medium", mode: "default", status: "idle", error: "", inputTokens: 1200, outputTokens: 34,
    createdAt: now, updatedAt: now, ...over,
  };
}

const toolUse = (id: string, method: string, path: string, extra: Record<string, unknown> = {}): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "tool_use", id, input: { method, path, ...extra } }],
});

function mockAssistant(opts: { enabled?: boolean; configured?: boolean; list?: AssistantConversation[]; detail?: AssistantDetail }) {
  server.use(
    http.get("/ai/status", () => HttpResponse.json({
      enabled: opts.enabled ?? true, configured: opts.configured ?? true, defaultModel: "claude-opus-5-5", defaultEffort: "medium",
    })),
    http.get("/ai/conversations", () => HttpResponse.json(opts.list ?? [])),
    http.get("/ai/conversations/:id", () => HttpResponse.json(opts.detail)),
  );
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  closed = false;
  constructor(
    public url: string,
    public opts?: unknown,
  ) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

describe("AssistantPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("explains when the assistant is off", async () => {
    mockAssistant({ enabled: false });
    renderWithQuery(<AssistantPanel />);
    expect(await screen.findByText("The AI assistant is turned off")).toBeInTheDocument();
  });

  it("explains when no API key is configured", async () => {
    mockAssistant({ configured: false });
    renderWithQuery(<AssistantPanel />);
    expect(await screen.findByText("No Claude API key yet")).toBeInTheDocument();
  });

  it("starts a server conversation and renders the transcript", async () => {
    let created: unknown;
    mockAssistant({
      detail: {
        conversation: conv(),
        pending: [],
        messages: [
          { role: "user", content: [{ type: "text", text: "Set the motd to Welcome" }] },
          { role: "assistant", content: [{ type: "text", text: "Reading the config." }, { type: "tool_use", id: "t1", input: { method: "GET", path: "/servers/lobby/files/read", query: { path: "/server.properties" } } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "HTTP 200\nmotd=old" }] },
          toolUse("t2", "POST", "/servers/lobby/files/write", { body: "motd=Welcome" }),
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "HTTP 403\nforbidden", is_error: true }] },
          { role: "assistant", content: [{ type: "tool_use", id: "t3", name: "edit_file", input: { file_path: "/server.properties", old_string: "motd=old", new_string: "motd=Hi" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "Edited /server.properties: 1 replacement(s)" }] },
          { role: "assistant", content: "You are not allowed to edit files on lobby." },
        ],
      },
    });
    server.use(http.post("/ai/conversations", async ({ request }) => {
      created = await request.json();
      return HttpResponse.json(conv({ status: "running" }), { status: 201 });
    }));
    renderWithQuery(<AssistantPanel scope={{ server: "lobby", namespace: "games", cluster: "local" }} />);
    expect(await screen.findByText("No conversations yet")).toBeInTheDocument();
    expect(screen.getByText(/only what your own permissions allow/)).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Message the assistant" });
    await userEvent.type(input, "Set the motd to Welcome{Enter}");
    await waitFor(() => expect(created).toEqual({ prompt: "Set the motd to Welcome", server: "lobby", namespace: "games", cluster: "local" }));
    expect(await screen.findByText("Reading the config.")).toBeInTheDocument();
    expect(screen.getByText("GET /servers/lobby/files/read?path=%2Fserver.properties")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("403")).toBeInTheDocument();
    expect(screen.getByText("motd=Welcome")).toBeInTheDocument();
    expect(screen.getByText("EDIT /server.properties")).toBeInTheDocument();
    expect(screen.getByText(/"new_string": "motd=Hi"/)).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(screen.getByText("You are not allowed to edit files on lobby.")).toBeInTheDocument();
    expect(screen.getByText("Claude Opus 5.5 · medium")).toBeInTheDocument();
    expect(screen.getByText("1,234 tokens")).toBeInTheDocument();
  });

  it("starts a conversation in the picked permission mode", async () => {
    let created: unknown;
    mockAssistant({ detail: { conversation: conv({ mode: "bypassPermissions" }), pending: [], messages: [] } });
    server.use(http.post("/ai/conversations", async ({ request }) => {
      created = await request.json();
      return HttpResponse.json(conv({ status: "running", mode: "bypassPermissions" }), { status: 201 });
    }));
    renderWithQuery(<AssistantPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Permission mode/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Bypass permissions" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Message the assistant" }), "Wipe it{Enter}");
    await waitFor(() => expect(created).toEqual({ prompt: "Wipe it", mode: "bypassPermissions" }));
  });

  it("asks for approval before destructive actions", async () => {
    const decisions: unknown[] = [];
    mockAssistant({
      list: [conv({ status: "awaiting_approval", title: "Delete old backup" })],
      detail: {
        conversation: conv({ status: "awaiting_approval" }),
        pending: [{ id: "t1", method: "DELETE", path: "/backups/b1" }],
        messages: [{ role: "user", content: "delete b1" }, toolUse("t1", "DELETE", "/backups/b1")],
      },
    });
    server.use(http.post("/ai/conversations/c1/approval", async ({ request }) => {
      decisions.push(await request.json());
      return HttpResponse.json(conv({ status: "running" }));
    }));
    renderWithQuery(<AssistantPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Delete old backup/ }));
    const card = await screen.findByRole("alert");
    expect(within(card).getByText("Approve this action?")).toBeInTheDocument();
    expect(within(card).getByText("DELETE /backups/b1")).toBeInTheDocument();
    expect(screen.getByText("needs approval")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await userEvent.click(within(card).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(decisions).toEqual([{ approve: false }]));
    await userEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decisions).toEqual([{ approve: false }, { approve: true }]));
  });

  it("stops a running conversation", async () => {
    let cancelled = false;
    mockAssistant({
      list: [conv({ status: "running", title: "Restart lobby" })],
      detail: {
        conversation: conv({ status: "running", error: "" }),
        pending: [],
        messages: [{ role: "user", content: "restart" }, toolUse("t1", "POST", "/servers/lobby:restart")],
      },
    });
    server.use(http.post("/ai/conversations/c1/cancel", () => {
      cancelled = true;
      return new HttpResponse(null, { status: 204 });
    }));
    renderWithQuery(<AssistantPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Restart lobby/ }));
    expect(await screen.findByText("Working…")).toBeInTheDocument();
    expect(screen.getByLabelText("Running")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(cancelled).toBe(true));
  });

  it("shows other users' conversations read-only to auditors", async () => {
    let query = "";
    mockAssistant({
      detail: {
        conversation: conv({ userId: 9, username: "bob", status: "error", error: "Stopped by the user." }),
        pending: [],
        messages: [{ role: "user", content: "hi" }, toolUse("t1", "GET", "/servers/lobby")],
      },
    });
    server.use(
      http.get("/users/me", () => HttpResponse.json(makeUser({ id: 1, role: "admin" }))),
      http.get("/ai/conversations", ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json(query === "?scope=all" ? [conv({ userId: 9, username: "bob", title: "Bob's chat" })] : []);
      }),
    );
    renderWithQuery(<AssistantPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "All users" }));
    await userEvent.click(await screen.findByRole("button", { name: /Bob's chat/ }));
    expect(query).toBe("?scope=all");
    expect(screen.getByText(/bob · lobby/)).toBeInTheDocument();
    expect(await screen.findByText("Stopped by the user.")).toBeInTheDocument();
    expect(screen.getByText("not run")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message the assistant" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /New conversation/ }));
    expect(screen.getByText("What should I do?")).toBeInTheDocument();
  });

  it("streams the reply while it is written and refetches once it is saved", async () => {
    let detail: AssistantDetail = {
      conversation: conv({ status: "running" }),
      pending: [],
      messages: [{ role: "user", content: "read the config" }],
    };
    mockAssistant({ list: [conv({ status: "running", title: "Live reply" })] });
    server.use(http.get("/ai/conversations/:id", () => HttpResponse.json(detail)));
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    renderWithQuery(<AssistantPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Live reply/ }));
    const source = await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
      return FakeEventSource.instances[0];
    });
    expect(source.url).toBe("/ai/conversations/c1/stream");

    await act(async () => {
      source.onmessage?.({ data: JSON.stringify({ text: "Reading" }) });
      source.onmessage?.({ data: "not json" });
    });
    expect(await screen.findByText("Reading")).toBeInTheDocument();
    expect(screen.queryByText("Working…")).not.toBeInTheDocument();

    detail = {
      conversation: conv({ status: "idle" }),
      pending: [],
      messages: [{ role: "user", content: "read the config" }, { role: "assistant", content: "Reading the config. Done." }],
    };
    await act(async () => {
      source.onmessage?.({ data: JSON.stringify({ flush: true }) });
    });
    expect(await screen.findByText("Reading the config. Done.")).toBeInTheDocument();
    await waitFor(() => expect(source.closed).toBe(true));
    expect(screen.queryByText("Reading")).not.toBeInTheDocument();
  });

  it("shows API errors from sending", async () => {
    mockAssistant({});
    server.use(http.post("/ai/conversations", () => new HttpResponse("the AI assistant is disabled", { status: 403 })));
    renderWithQuery(<AssistantPanel />);
    await userEvent.type(await screen.findByRole("textbox", { name: "Message the assistant" }), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/the AI assistant is disabled/)).toBeInTheDocument();
  });
});
