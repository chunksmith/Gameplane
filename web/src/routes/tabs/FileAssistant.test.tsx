import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import type { AssistantConversation, AssistantDetail } from "@/lib/assistant";
import { FileAssistant } from "./FileAssistant";

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: ({ modified }: { modified: string }) => <pre data-testid="diff">{modified}</pre>,
}));

const now = new Date().toISOString();

function conv(over: Partial<AssistantConversation> = {}): AssistantConversation {
  return {
    id: "c1", userId: 1, username: "admin", title: "Edit config", cluster: "local", namespace: "games", server: "lobby",
    model: "claude-opus-5-5", effort: "medium", mode: "default", status: "idle", error: "", inputTokens: 0, outputTokens: 0,
    createdAt: now, updatedAt: now, ...over,
  };
}

function mockStatus(enabled = true) {
  server.use(http.get("/ai/status", () => HttpResponse.json({ enabled, configured: true, defaultModel: "claude-opus-5-5", defaultEffort: "medium", defaultMode: "default" })));
}

async function send(text: string) {
  fireEvent.change(await screen.findByRole("textbox", { name: "Message Claude" }), { target: { value: text } });
  await userEvent.click(screen.getByRole("button", { name: /Send/ }));
}

const file = (over: Partial<{ onApply: (next: string) => void; onSaved: () => void }> = {}) => ({
  path: "plugins/Essentials/config.yml", language: "yaml", content: "delay: 0\n", canControl: true,
  onApply: vi.fn(), onSaved: vi.fn(), ...over,
});

describe("FileAssistant", () => {
  it("explains that the assistant is not set up", async () => {
    mockStatus(false);
    renderWithQuery(<FileAssistant scope={{}} file={file()} onClose={vi.fn()} />);
    expect(await screen.findByText(/The AI assistant is not set up/)).toBeInTheDocument();
  });

  it("sends the picked model with its fixed effort and the file as context", async () => {
    mockStatus();
    let body: Record<string, unknown> = {};
    server.use(
      http.post("/ai/conversations", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(conv(), { status: 201 });
      }),
      http.get("/ai/conversations/:id", () => HttpResponse.json({ conversation: conv(), messages: [], pending: [] })),
    );
    renderWithQuery(<FileAssistant scope={{}} file={file()} onClose={vi.fn()} />);
    expect(await screen.findByText("Ask Claude to explain or change config.yml.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Model/ })).toHaveTextContent("Opus 5.5 · medium");
    await userEvent.click(screen.getByRole("button", { name: /Model/ }));
    await userEvent.click(screen.getByRole("option", { name: /Sonnet 5.5/ }));
    await send("Set the delay to 3");
    await waitFor(() => expect(body.model).toBe("claude-sonnet-5-5"));
    expect(body.effort).toBe("high");
    expect(String(body.prompt)).toContain("Current content:\n```\ndelay: 0\n");
  });

  const suggestion: AssistantDetail = {
    conversation: conv({ status: "awaiting_approval" }),
    messages: [
      { role: "user", content: "Set the delay to 3" },
      { role: "assistant", content: [{ type: "text", text: "Here it is:\n```yaml\ndelay: 3\n```" }, { type: "tool_use", id: "t1", input: { method: "POST", path: "/servers/lobby/files/write" } }] },
    ],
    pending: [{ id: "t1", method: "POST", path: "/servers/lobby/files/write" }],
  };

  function mockSuggestion() {
    mockStatus();
    server.use(
      http.post("/ai/conversations", () => HttpResponse.json(conv({ status: "awaiting_approval" }), { status: 201 })),
      http.get("/ai/conversations/:id", () => HttpResponse.json(suggestion)),
    );
  }

  it("applies or discards a suggested change", async () => {
    mockSuggestion();
    const onApply = vi.fn();
    renderWithQuery(<FileAssistant scope={{}} file={file({ onApply })} onClose={vi.fn()} />);
    await send("Set the delay to 3");
    expect(await screen.findByTestId("diff")).toHaveTextContent("delay: 3");
    expect(screen.getByText("POST /servers/lobby/files/write")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Apply to editor/ }));
    expect(onApply).toHaveBeenCalledWith("delay: 3\n");
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByTestId("diff")).not.toBeInTheDocument();
  });

  it("answers an approval", async () => {
    mockSuggestion();
    let decided: unknown;
    server.use(
      http.post("/ai/conversations/:id/approval", async ({ request }) => {
        decided = await request.json();
        return HttpResponse.json(conv());
      }),
    );
    renderWithQuery(<FileAssistant scope={{}} file={file()} onClose={vi.fn()} />);
    await send("Set the delay to 3");
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decided).toEqual({ approve: true }));
  });

  it("opens, switches and closes chat tabs", async () => {
    mockSuggestion();
    const onClose = vi.fn();
    renderWithQuery(<FileAssistant scope={{}} onClose={onClose} />);
    await send("Set the delay to 3");
    expect(await screen.findByRole("tab", { name: "Edit config" })).toHaveAttribute("aria-selected", "true");

    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.getByRole("tab", { name: "New chat" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText(/Type @ to add a file or folder as context/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Edit config" }));
    expect(await screen.findByText("Set the delay to 3")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Close Edit config" }));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["New chat"]);
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Close New chat" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes from the header", async () => {
    mockStatus();
    const onClose = vi.fn();
    renderWithQuery(<FileAssistant scope={{}} onClose={onClose} />);
    expect(await screen.findByText(/Type @ to add a file or folder as context/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close chat" }));
    expect(onClose).toHaveBeenCalled();
  });
});
