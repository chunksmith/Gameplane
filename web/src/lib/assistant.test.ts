import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/server";
import { Assistant, AssistantAdmin, blocksOf, callLabel, modelLabel, resultStatus, resultText, scopeQuery } from "./assistant";

describe("assistant helpers", () => {
  it("builds the conversation list query", () => {
    expect(scopeQuery({}, false)).toBe("");
    expect(scopeQuery({ server: "lobby", namespace: "games" }, false)).toBe("?server=lobby&namespace=games&cluster=local");
    expect(scopeQuery({ server: "lobby", namespace: "games", cluster: "eu" }, false)).toBe("?server=lobby&namespace=games&cluster=eu");
    expect(scopeQuery({ server: "lobby" }, true)).toBe("?scope=all");
  });

  it("reads message blocks and tool results", () => {
    expect(blocksOf({ role: "user", content: "hi" })).toEqual([{ type: "text", text: "hi" }]);
    expect(blocksOf({ role: "assistant", content: [{ type: "text", text: "ok" }] })).toEqual([{ type: "text", text: "ok" }]);
    expect(resultText({ type: "tool_result", content: "HTTP 200\nok" })).toBe("HTTP 200\nok");
    expect(resultText({ type: "tool_result", content: [{ type: "text", text: "a" }, { type: "image" }] })).toBe("a\n");
    expect(resultText({ type: "tool_result" })).toBe("");
    expect(resultStatus("HTTP 403\nforbidden")).toBe("403");
    expect(resultStatus("The user declined this action.")).toBe("");
    expect(callLabel({ type: "tool_use", input: { method: "get", path: "/servers/a/files/read", query: { path: "/x" } } })).toBe("GET /servers/a/files/read?path=%2Fx");
    expect(callLabel({ type: "tool_use", input: { method: "POST", path: "/servers/a:restart" } })).toBe("POST /servers/a:restart");
    expect(callLabel({ type: "tool_use" })).toBe("");
    expect(modelLabel("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelLabel("custom-model")).toBe("custom-model");
  });

  it("survives tool input the model made up", () => {
    expect(callLabel({ type: "tool_use", input: { method: "GET", path: "/servers", query: ["path", "/x"] } })).toBe("GET /servers");
    expect(callLabel({ type: "tool_use", input: { method: "GET", path: "/servers", query: "path=/x" } })).toBe("GET /servers");
    expect(callLabel({ type: "tool_use", input: { method: "GET", path: "/backups", query: { recursive: true } } })).toBe("GET /backups?recursive=true");
    expect(blocksOf({ role: "assistant", content: null as never })).toEqual([]);
    expect(blocksOf({ role: "assistant", content: [null as never, { type: "text", text: "ok" }] })).toEqual([{ type: "text", text: "ok" }]);
    expect(resultText({ type: "tool_result", content: { text: "nope" } as never })).toBe("");
  });

  it("calls the assistant endpoints", async () => {
    const seen: string[] = [];
    server.use(
      http.all(/\/(ai|admin\/ai)\//, async ({ request }) => {
        const url = new URL(request.url);
        const body = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
        seen.push(`${request.method} ${url.pathname}${url.search} ${body}`.trim());
        if (request.method === "DELETE") return new HttpResponse(null, { status: 204 });
        return HttpResponse.json({ id: "c1" });
      }),
    );
    await Assistant.create("hi", { server: "lobby", namespace: "games", cluster: "local" });
    await Assistant.send("c1", "more");
    await Assistant.decide("c1", true);
    await Assistant.cancel("c1");
    await Assistant.get("c1");
    await Assistant.list({}, false);
    await Assistant.status();
    await AssistantAdmin.putSecret("sk-ant");
    await AssistantAdmin.deleteSecret();
    expect(seen).toEqual([
      `POST /ai/conversations {"prompt":"hi","server":"lobby","namespace":"games","cluster":"local"}`,
      `POST /ai/conversations/c1/messages {"prompt":"more"}`,
      `POST /ai/conversations/c1/approval {"approve":true}`,
      "POST /ai/conversations/c1/cancel",
      "GET /ai/conversations/c1",
      "GET /ai/conversations",
      "GET /ai/status",
      `PUT /admin/ai/secret {"apiKey":"sk-ant"}`,
      "DELETE /admin/ai/secret",
    ]);
  });
});
