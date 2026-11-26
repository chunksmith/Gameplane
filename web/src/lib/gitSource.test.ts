import { describe, expect, it } from "vitest";
import { GIT_SOURCE_CONTAINER, gitSourceContainer, gitSourceOf, validGitUrl, withGitSource } from "./gitSource";

const source = { url: "https://github.com/org/server", ref: "main", secretName: "repo", secretKey: "" };

describe("gitSource", () => {
  it("round-trips a source through its init container", () => {
    const container = gitSourceContainer(source);
    expect(container.name).toBe(GIT_SOURCE_CONTAINER);
    expect(container.volumeMounts).toEqual([{ name: "data", mountPath: "/target" }]);
    expect(gitSourceOf([container])).toEqual({ ...source, secretKey: "token" });
  });

  it("keeps other init containers and an unchanged git container", () => {
    const other = { name: "tools", image: "busybox" };
    const stale = { ...gitSourceContainer(source), command: ["sh", "-c", "old script"] };
    expect(withGitSource([stale, other], { ...source, secretKey: "token" })).toEqual([stale, other]);
    const changed = withGitSource([stale, other], { ...source, ref: "dev" })!;
    expect(changed[0].command).not.toEqual(stale.command);
    expect(gitSourceOf(changed)?.ref).toBe("dev");
    expect(withGitSource([stale, other], undefined)).toEqual([other]);
    expect(withGitSource([stale], undefined)).toBeUndefined();
  });

  it("accepts https and ssh urls only", () => {
    expect(validGitUrl("https://github.com/org/repo.git")).toBe(true);
    expect(validGitUrl("git@github.com:org/repo.git")).toBe(true);
    expect(validGitUrl("ssh://git@host/repo")).toBe(true);
    expect(validGitUrl("http://insecure/repo")).toBe(false);
    expect(validGitUrl("not a url")).toBe(false);
  });
});
