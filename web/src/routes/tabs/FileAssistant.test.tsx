import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
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
    await userEvent.type(screen.getByRole("textbox", { name: "Message Claude" }), "Set the delay to 3");
    await userEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(body.model).toBe("claude-sonnet-5-5"));
    expect(body.effort).toBe("high");
    expect(String(body.prompt)).toContain("Current content:\n```\ndelay: 0\n```");
  });

  it("applies or discards a suggested change and answers an approval", async () => {
    mockStatus();
    const onApply = vi.fn();
    let decided: unknown;
    const detail: AssistantDetail = {
      conversation: conv({ status: "awaiting_approval" }),
      messages: [
        { role: "user", content: "Set the delay to 3" },
        { role: "assistant", content: [{ type: "text", text: "Here it is:\n```yaml\ndelay: 3\n```" }, { type: "tool_use", id: "t1", input: { method: "POST", path: "/servers/lobby/files/write" } }] },
      ],
      pending: [{ id: "t1", method: "POST", path: "/servers/lobby/files/write" }],
    };
    server.use(
      http.post("/ai/conversations", () => HttpResponse.json(conv({ status: "awaiting_approval" }), { status: 201 })),
      http.get("/ai/conversations/:id", () => HttpResponse.json(detail)),
      http.post("/ai/conversations/:id/approval", async ({ request }) => {
        decided = await request.json();
        return HttpResponse.json(conv());
      }),
    );
    renderWithQuery(<FileAssistant scope={{}} file={file({ onApply })} onClose={vi.fn()} />);
    await userEvent.type(await screen.findByRole("textbox", { name: "Message Claude" }), "Set the delay to 3");
    await userEvent.click(screen.getByRole("button", { name: /Send/ }));
    expect(await screen.findByTestId("diff")).toHaveTextContent("delay: 3");
    expect(screen.getByText("Set the delay to 3")).toBeInTheDocument();
    expect(screen.getByText("POST /servers/lobby/files/write")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Apply to editor/ }));
    expect(onApply).toHaveBeenCalledWith("delay: 3\n");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decided).toEqual({ approve: true }));
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByTestId("diff")).not.toBeInTheDocument();
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
