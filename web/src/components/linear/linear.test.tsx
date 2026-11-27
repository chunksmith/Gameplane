import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { makeRepository } from "@/test/factories";
import { RepositoryLinks } from "./RepositoryLinks";

describe("RepositoryLinks", () => {
  it("saves the chosen project to repository mapping", async () => {
    let saved: unknown[] = [];
    server.use(
      http.get("/ai/linear/projects", () => HttpResponse.json([{ id: "p1", name: "LitHomes" }])),
      http.get("/ai/linear/links", () => HttpResponse.json([])),
      http.get("/repositories", () => HttpResponse.json([makeRepository({ name: "lithomes", namespace: "gameplane-games" })])),
      http.put("/ai/linear/links", async ({ request }) => {
        saved = await request.json() as unknown[];
        return HttpResponse.json(saved);
      }),
    );
    renderWithQuery(<RepositoryLinks />);
    await userEvent.click(await screen.findByLabelText("Repository for LitHomes"));
    await userEvent.click(await screen.findByRole("option", { name: "lithomes · gameplane-games" }));
    await userEvent.click(screen.getByRole("button", { name: "Save links" }));
    await waitFor(() => expect(saved).toEqual([{ projectId: "p1", projectName: "LitHomes", repository: "lithomes", namespace: "gameplane-games" }]));
  });
});
