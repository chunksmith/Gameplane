import { describe, it, expect } from "vitest";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { server } from "@/test/server";
import { makeClient } from "@/test/render";
import { makeGitStatus, makeRepository } from "@/test/factories";
import { APIError } from "@/lib/api";
import { englishIntl } from "@/lib/i18n/format";
import type { ResourceTarget } from "@/lib/resourceTarget";
import { busyPhase, gitErrorText, initials, repoSlug, useGitMarks } from "./repositories";

const target: ResourceTarget = { cluster: "local", namespace: "gameplane-games", name: "site", uid: "site-uid", resource: "repositories" };

describe("busyPhase", () => {
  it.each([
    ["Pending", true],
    ["Cloning", true],
    ["Ready", false],
    ["Failed", false],
  ] as const)("is %s -> %s", (phase, expected) => {
    expect(busyPhase(makeRepository({ phase }))).toBe(expected);
  });
});

describe("gitErrorText", () => {
  it("appends the conflicted files of an API error", () => {
    const err = new APIError(409, JSON.stringify({ detail: "conflict", files: ["a.txt", "b.txt"] }), "Conflict", "application/problem+json");
    expect(gitErrorText(englishIntl, err)).toBe("conflict Files: a.txt, b.txt");
  });

  it("returns the plain message when there are no files", () => {
    const err = new APIError(500, JSON.stringify({ error: "boom" }), "Server Error", "application/json");
    expect(gitErrorText(englishIntl, err)).toBe("boom");
  });

  it("returns the message of a non-API error", () => {
    expect(gitErrorText(englishIntl, new Error("offline"))).toBe("offline");
  });
});

describe("useGitMarks", () => {
  it("maps changed files to their state and skips directories", async () => {
    server.use(http.get("/repositories/:name/git/status", () => HttpResponse.json(makeGitStatus({
      changes: [
        { path: "config.yml", state: "M", staged: false, additions: 1, deletions: 1 },
        { path: "plugins/a.jar", state: "U", staged: false, additions: 0, deletions: 0 },
        { path: "plugins/", state: "U", staged: false, additions: 0, deletions: 0 },
      ],
    }))));
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={makeClient()}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useGitMarks(target), { wrapper });
    expect(result.current.size).toBe(0);
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get("/config.yml")).toBe("M");
    expect(result.current.get("/plugins/a.jar")).toBe("U");
    expect(result.current.has("/plugins/")).toBe(false);
  });
});

describe("repoSlug and initials", () => {
  it("strips the GitHub prefix and .git suffix", () => {
    expect(repoSlug("https://github.com/chunksmith/site.git")).toBe("chunksmith/site");
  });

  it("uses the first letters of the first two words", () => {
    expect(initials("my-cool_repo.git")).toBe("MC");
  });
});
