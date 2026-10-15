import { describe, expect, it } from "vitest";
import { parseAnsi } from "./ansi";

describe("parseAnsi", () => {
  it("turns SGR colors into styled segments and strips the escapes", () => {
    const esc = String.fromCharCode(27);
    const segments = parseAnsi(`${esc}[m[16:01:31 INFO]: ${esc}[91m- ${esc}[38;5;196mred${esc}[0m done`);
    expect(segments.map((segment) => segment.text).join("")).toBe("[16:01:31 INFO]: - red done");
    expect(segments[0]).toEqual({ text: "[16:01:31 INFO]: " });
    expect(segments[1].style?.color).toBe("#fca5a5");
    expect(segments[2].style?.color).toBe("rgb(255, 0, 0)");
    expect(segments[3]).toEqual({ text: " done" });
  });

  it("leaves plain lines as a single unstyled segment", () => {
    expect(parseAnsi("plain line")).toEqual([{ text: "plain line" }]);
  });
});
