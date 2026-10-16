import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithQuery } from "@/test/render";
import { AssistantPage } from "./Assistant";

describe("AssistantPage", () => {
  it("renders the page header and the assistant panel", async () => {
    renderWithQuery(<AssistantPage />);
    expect(screen.getByRole("heading", { name: "Assistant" })).toBeInTheDocument();
    expect(await screen.findByText("The AI assistant is turned off")).toBeInTheDocument();
  });
});
