import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeConfig } from "@/test/factories";
import type { AICfg } from "@/lib/config";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

import { AdminSettingsPage } from "./AdminSettings";

async function gotoAI(ai?: AICfg) {
  server.use(http.get("/admin/config", () => HttpResponse.json(makeConfig({ ai }))));
  renderWithQuery(<AdminSettingsPage />);
  await screen.findByRole("heading", { name: /Admin settings/i });
  await userEvent.click(await screen.findByRole("button", { name: /AI assistant/i }));
}

describe("AdminSettings AI assistant", () => {
  it("enables the assistant, stores the key and saves the defaults", async () => {
    const calls: string[] = [];
    let secretBody: unknown;
    let saved: unknown;
    server.use(
      http.put("/admin/ai/secret", async ({ request }) => {
        calls.push("secret");
        secretBody = await request.json();
        return HttpResponse.json({ name: "gameplane-ai", keys: ["apiKey"] });
      }),
      http.put("/admin/config/ai", async ({ request }) => {
        calls.push("config");
        saved = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await gotoAI();
    expect(await screen.findByText("Not configured")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "Enable the AI assistant" }));
    expect(screen.getByRole("switch", { name: "Enable the AI assistant" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("button", { name: /Set API key/i }));
    await userEvent.type(screen.getByLabelText(/API key/i), "sk-ant-test");
    await userEvent.click(screen.getByRole("button", { name: /Use this key/i }));
    expect(await screen.findByText("Configured")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Default model/i }));
    await userEvent.click(await screen.findByRole("option", { name: "Claude Sonnet 5.5" }));
    expect(calls).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: /^Save changes$/i }));
    await waitFor(() => expect(saved).toBeDefined());
    expect(calls).toEqual(["secret", "config"]);
    expect(secretBody).toEqual({ apiKey: "sk-ant-test" });
    expect(saved).toEqual({ enabled: true, defaultModel: "claude-sonnet-5-5", defaultEffort: "medium", apiKeySet: true });
  });

  it("saves the default permission mode", async () => {
    let saved: unknown;
    server.use(http.put("/admin/config/ai", async ({ request }) => {
      saved = await request.json();
      return new HttpResponse(null, { status: 204 });
    }));
    await gotoAI({ enabled: true, defaultModel: "claude-opus-5-5", defaultEffort: "medium", apiKeySet: true });
    await userEvent.click(await screen.findByRole("button", { name: /Default permission mode/i }));
    await userEvent.click(await screen.findByRole("option", { name: "Bypass permissions" }));
    await userEvent.click(screen.getByRole("button", { name: /^Save changes$/i }));
    await waitFor(() => expect(saved).toEqual({ enabled: true, defaultModel: "claude-opus-5-5", defaultEffort: "medium", apiKeySet: true, defaultMode: "bypassPermissions" }));
  });

  it("removes a configured key on save", async () => {
    let deleted = false;
    let saved: unknown;
    server.use(
      http.delete("/admin/ai/secret", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.put("/admin/config/ai", async ({ request }) => {
        saved = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await gotoAI({ enabled: true, defaultModel: "claude-opus-5-5", defaultEffort: "high", apiKeySet: true });
    expect(await screen.findByText("Configured")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Remove$/i }));
    expect(await screen.findByText("Not configured")).toBeInTheDocument();
    expect(deleted).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: /^Save changes$/i }));
    await waitFor(() => expect(saved).toBeDefined());
    await waitFor(() => expect(deleted).toBe(true));
    expect(saved).toEqual({ enabled: true, defaultModel: "claude-opus-5-5", defaultEffort: "high", apiKeySet: false });
  });

  it("cancels the key form without staging anything", async () => {
    await gotoAI({ enabled: false, defaultModel: "claude-opus-5-5", defaultEffort: "medium", apiKeySet: true });
    await userEvent.click(await screen.findByRole("button", { name: /^Replace$/i }));
    expect(screen.getByRole("button", { name: /Use this key/i })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/API key/i), "sk-ant-other");
    await userEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(screen.queryByLabelText(/API key/i)).not.toBeInTheDocument();
    expect(screen.getByText("Configured")).toBeInTheDocument();
  });

  it("stores a subscription token", async () => {
    let secretBody: unknown;
    let saved: unknown;
    server.use(
      http.put("/admin/ai/secret", async ({ request }) => {
        secretBody = await request.json();
        return HttpResponse.json({ name: "gameplane-ai", keys: ["apiKey", "oauthToken"] });
      }),
      http.put("/admin/config/ai", async ({ request }) => {
        saved = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await gotoAI();
    await userEvent.click(await screen.findByRole("button", { name: /Set subscription token/i }));
    expect(screen.getByRole("button", { name: /Use this token/i })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Subscription token/i), "sk-ant-oat01-test");
    await userEvent.click(screen.getByRole("button", { name: /Use this token/i }));
    expect(await screen.findByText("Configured")).toBeInTheDocument();
    expect(screen.getByText(/Claude subscription token\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Replace$/i }));
    expect(screen.getByLabelText(/Subscription token/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^Save changes$/i }));
    await waitFor(() => expect(saved).toBeDefined());
    expect(secretBody).toEqual({ oauthToken: "sk-ant-oat01-test" });
    expect(saved).toEqual({ enabled: false, defaultModel: "claude-opus-5-5", defaultEffort: "medium", apiKeySet: true, subscriptionSet: true });
  });
});
