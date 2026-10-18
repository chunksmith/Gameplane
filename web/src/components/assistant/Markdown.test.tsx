import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders bold, italic, strikethrough, inline code and links", () => {
    render(<Markdown text="**lfln-velocity** is *up*, ~~gone~~ `motd` [docs](https://gameplane.net/docs)" />);
    expect(screen.getByText("lfln-velocity").tagName).toBe("STRONG");
    expect(screen.getByText("up").tagName).toBe("EM");
    expect(screen.getByText("gone").tagName).toBe("S");
    expect(screen.getByText("motd").tagName).toBe("CODE");
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("href", "https://gameplane.net/docs");
  });

  it("renders fenced code blocks with the language and a copy button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Markdown text={"Config:\n```toml\nmotd = \"A Velocity Server\"\n```"} />);
    expect(screen.getByText("toml")).toBeInTheDocument();
    expect(screen.getByText('motd = "A Velocity Server"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith('motd = "A Velocity Server"');
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("renders headings, lists, quotes and rules", () => {
    render(<Markdown text={"## Servers\n- lobby\n- survival\n\n1. read\n2. write\n\n> careful\n\n---\nplain line"} />);
    expect(screen.getByRole("heading", { name: "Servers" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["lobby", "survival", "read", "write"]);
    expect(screen.getByText("careful").closest("blockquote")).not.toBeNull();
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByText("plain line")).toBeInTheDocument();
  });

  it("renders GFM tables", () => {
    render(<Markdown text={"| Server | Template |\n|---|---|\n| ardiy-paper | `paper` |\n| sonblok-smp | golempaper |"} />);
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Server", "Template"]);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("paper").tagName).toBe("CODE");
    expect(screen.getByRole("cell", { name: "sonblok-smp" })).toBeInTheDocument();
  });

  it("keeps an unterminated code fence readable", () => {
    render(<Markdown text={"```\n<#09add3>A Velocity Server"} />);
    expect(screen.getByText("<#09add3>A Velocity Server")).toBeInTheDocument();
    expect(screen.getByText("text")).toBeInTheDocument();
  });
});
