import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "@/test/server";
import { renderWithQuery } from "@/test/render";
import { BuildModuleDialog } from "./BuildModuleDialog";

const mockScaffoldResponse = {
  moduleYaml: "apiVersion: gameplane.local/module/v1\nname: test-module\nversion: 1.0.0\n",
  templateYaml: "apiVersion: gameplane.local/v1alpha1\nkind: GameTemplate\nspec:\n  game: test-game\n",
  readmeMd: "# Test Module\n",
  iconBase64: "",
};

const mockValidateResponse = {
  clean: true,
  errorCount: 0,
  warningCount: 0,
  findings: [],
};

const mockPreviewResponse = {
  resolvedImage: "ghcr.io/valgul/test:v1@sha256:1111111111111111111111111111111111111111111111111111111111111111",
  effectiveEnv: [
    { name: "MAX_MEMORY", value: "6144M", source: "configSchema" },
  ],
  computedConfig: {
    MAX_MEMORY: "6144M",
  },
  ports: [
    { name: "game", containerPort: 27015, protocol: "UDP", advertise: true },
  ],
  storage: {
    size: "20Gi",
    mountPath: "/data",
  },
};

describe("BuildModuleDialog", () => {
  it("renders wizard step 1 with archetypes and validates DNS-1123 name", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <BuildModuleDialog open onOpenChange={() => undefined} sources={["uploads"]} />
    );

    expect(screen.getByText("Create game module")).toBeInTheDocument();
    expect(await screen.findByText("SteamCMD Dedicated Server")).toBeInTheDocument();
    expect(await screen.findByText("Java Application Server")).toBeInTheDocument();
    expect(await screen.findByText("Generic Container Server")).toBeInTheDocument();

    const nameInput = screen.getByPlaceholderText("e.g. cs2-match");
    expect(nameInput).toHaveValue("");
    expect(screen.getByRole("button", { name: /Continue to Container & Ports/i })).toBeDisabled();

    // Invalid DNS name
    await user.clear(nameInput);
    await user.type(nameInput, "INVALID_UPPERCASE");
    expect(screen.getByText("Must be lowercase alphanumeric with hyphens")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue to Container & Ports/i })).toBeDisabled();

    // Valid DNS name
    await user.clear(nameInput);
    await user.type(nameInput, "cs2-server");
    expect(screen.getByText("✓ Valid DNS-1123 label")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue to Container & Ports/i })).not.toBeDisabled();
  });

  it("navigates through step 1, 2, and 3 with live scaffold and validation", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/modules/builder/scaffold", () => HttpResponse.json(mockScaffoldResponse)),
      http.post("/modules/builder/validate", () => HttpResponse.json(mockValidateResponse)),
      http.post("/modules/builder/preview", () => HttpResponse.json(mockPreviewResponse)),
    );

    renderWithQuery(
      <BuildModuleDialog open onOpenChange={() => undefined} sources={["uploads"]} />
    );

    // Provide valid module name
    await user.type(screen.getByPlaceholderText("e.g. cs2-match"), "my-game");

    // Step 1 -> Step 2
    await user.click(screen.getByRole("button", { name: /Continue to Container & Ports/i }));
    expect(await screen.findByText("Container Image")).toBeInTheDocument();
    expect(screen.getByText("Port Mappings")).toBeInTheDocument();
    expect(screen.getByText("Persistent Storage")).toBeInTheDocument();

    // Step 2 -> Step 3
    await user.click(screen.getByRole("button", { name: /Continue to Review & Export/i }));

    // Step 3 Review & Export
    expect(await screen.findByText("Module Validated Cleanly")).toBeInTheDocument();
    expect(screen.getByText("Memory Simulation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download .tar.gz/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Install to Cluster/i })).toBeInTheDocument();
  });

  it("installs module directly to cluster from step 3", async () => {
    const user = userEvent.setup();
    let exportCalled = false;
    server.use(
      http.post("/modules/builder/scaffold", () => HttpResponse.json(mockScaffoldResponse)),
      http.post("/modules/builder/validate", () => HttpResponse.json(mockValidateResponse)),
      http.post("/modules/builder/preview", () => HttpResponse.json(mockPreviewResponse)),
      http.post("/modules/builder/export", () => {
        exportCalled = true;
        return HttpResponse.json({ installed: true, moduleName: "my-game" }, { status: 201 });
      }),
    );

    const onInstalled = vi.fn();
    const onOpenChange = vi.fn();

    renderWithQuery(
      <BuildModuleDialog open onOpenChange={onOpenChange} sources={["uploads"]} onInstalled={onInstalled} />
    );

    // Provide valid module name
    await user.type(screen.getByPlaceholderText("e.g. cs2-match"), "my-game");

    // Navigate to step 3
    await user.click(screen.getByRole("button", { name: /Continue to Container & Ports/i }));
    expect(await screen.findByText("Container Image")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Continue to Review & Export/i }));
    expect(await screen.findByText("Module Validated Cleanly")).toBeInTheDocument();

    // Install to cluster
    const installBtn = screen.getByRole("button", { name: /Install to Cluster/i });
    await user.click(installBtn);

    await waitFor(() => {
      expect(exportCalled).toBe(true);
      expect(onInstalled).toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("handles download archive in step 3", async () => {
    const user = userEvent.setup();
    let downloadCalled = false;
    server.use(
      http.post("/modules/builder/scaffold", () => HttpResponse.json(mockScaffoldResponse)),
      http.post("/modules/builder/validate", () => HttpResponse.json(mockValidateResponse)),
      http.post("/modules/builder/preview", () => HttpResponse.json(mockPreviewResponse)),
      http.post("/modules/builder/export", () => {
        downloadCalled = true;
        return new HttpResponse(new Blob(["fake tar"]), {
          status: 200,
          headers: { "Content-Type": "application/gzip" },
        });
      }),
    );

    renderWithQuery(
      <BuildModuleDialog open onOpenChange={() => undefined} sources={["uploads"]} />
    );

    await user.type(screen.getByPlaceholderText("e.g. cs2-match"), "my-game");
    await user.click(screen.getByRole("button", { name: /Continue to Container & Ports/i }));
    expect(await screen.findByText("Container Image")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Continue to Review & Export/i }));
    expect(await screen.findByText("Module Validated Cleanly")).toBeInTheDocument();

    const downloadBtn = screen.getByRole("button", { name: /Download .tar.gz/i });
    await user.click(downloadBtn);

    await waitFor(() => {
      expect(downloadCalled).toBe(true);
    });
  });

  it("adds, updates, and removes ports in step 2", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/modules/builder/scaffold", () => HttpResponse.json(mockScaffoldResponse)),
      http.post("/modules/builder/validate", () => HttpResponse.json(mockValidateResponse)),
      http.post("/modules/builder/preview", () => HttpResponse.json(mockPreviewResponse)),
    );

    renderWithQuery(
      <BuildModuleDialog open onOpenChange={() => undefined} sources={["uploads"]} />
    );

    await user.type(screen.getByPlaceholderText("e.g. cs2-match"), "my-game");
    await user.click(screen.getByRole("button", { name: /Continue to Container & Ports/i }));
    await screen.findByText("Port Mappings");

    // Initial port should exist (from archetype default)
    const portInputs = screen.getAllByPlaceholderText("name");
    const initialPortCount = portInputs.length;
    expect(initialPortCount).toBeGreaterThan(0);

    // Add a new port
    await user.click(screen.getByRole("button", { name: /Add Port/i }));
    expect(screen.getAllByPlaceholderText("name")).toHaveLength(initialPortCount + 1);

    // Update the new port's name
    const newPortNameInput = screen.getAllByPlaceholderText("name")[initialPortCount];
    await user.clear(newPortNameInput);
    await user.type(newPortNameInput, "metrics");
    expect(newPortNameInput).toHaveValue("metrics");

    // Update the port number
    const portNumberInputs = screen.getAllByPlaceholderText("port");
    await user.clear(portNumberInputs[initialPortCount]);
    await user.type(portNumberInputs[initialPortCount], "9090");
    expect(portNumberInputs[initialPortCount]).toHaveValue(9090);

    // Remove a port (only if we have more than 1)
    if (screen.getAllByPlaceholderText("name").length > 1) {
      const trashButtons = screen.getAllByRole("button", { name: /Remove port/i });
      await user.click(trashButtons[0]);
      expect(screen.getAllByPlaceholderText("name")).toHaveLength(initialPortCount);
    }
  });

  it("handles custom tag input with Enter key", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/modules/builder/archetypes", () =>
        HttpResponse.json({
          archetypes: [
            {
              id: "steamcmd",
              title: "SteamCMD",
              description: "SteamCMD server",
              defaultImage: "img:latest",
              defaultPorts: [],
              defaultStorage: { size: "10Gi", mountPath: "/data" },
            },
          ],
        })
      )
    );

    renderWithQuery(
      <BuildModuleDialog open onOpenChange={() => undefined} sources={[]} />
    );

    await screen.findByText("SteamCMD");

    const customTagInput = screen.getByPlaceholderText("Add custom tag...");
    const addTagButton = screen.getByRole("button", { name: /Add tag/i });

    // Type a custom tag and click button
    await user.type(customTagInput, "hardcore");
    await user.click(addTagButton);
    expect(screen.getByText(/hardcore ×/)).toBeInTheDocument();
    expect(customTagInput).toHaveValue("");

    // Type another tag and press Enter
    await user.type(customTagInput, "pvp");
    await user.keyboard("{Enter}");
    expect(screen.getByText(/pvp ×/)).toBeInTheDocument();
    expect(customTagInput).toHaveValue("");

    // Duplicate tag should not be added
    await user.type(customTagInput, "hardcore");
    await user.click(addTagButton);
    expect(screen.getAllByText(/hardcore ×/)).toHaveLength(1);

    // Remove a custom tag by clicking it
    const pvpTag = screen.getByText(/pvp ×/);
    await user.click(pvpTag);
    expect(screen.queryByText(/pvp ×/)).not.toBeInTheDocument();
    expect(screen.getByText(/hardcore ×/)).toBeInTheDocument();
  });

  it("switches memory simulation values and triggers revalidation", async () => {
    const user = userEvent.setup();
    let validateCallCount = 0;
    server.use(
      http.post("/modules/builder/scaffold", () => HttpResponse.json(mockScaffoldResponse)),
      http.post("/modules/builder/validate", () => {
        validateCallCount++;
        return HttpResponse.json(mockValidateResponse);
      }),
      http.post("/modules/builder/preview", () => HttpResponse.json(mockPreviewResponse)),
    );

    renderWithQuery(
      <BuildModuleDialog open onOpenChange={() => undefined} sources={["uploads"]} />
    );

    await user.type(screen.getByPlaceholderText("e.g. cs2-match"), "my-game");
    await user.click(screen.getByRole("button", { name: /Continue to Container & Ports/i }));
    await screen.findByText("Container Image");
    await user.click(screen.getByRole("button", { name: /Continue to Review & Export/i }));
    await screen.findByText("Memory Simulation");

    // Default is 8Gi
    expect(screen.getByRole("button", { name: /^8Gi$/i })).toHaveClass("border-primary");

    // Click 16Gi
    const validateBefore = validateCallCount;
    await user.click(screen.getByRole("button", { name: /^16Gi$/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^16Gi$/i })).toHaveClass("border-primary");
    });
    // Revalidation should have been called
    await waitFor(() => {
      expect(validateCallCount).toBeGreaterThan(validateBefore);
    });

    // Click 2Gi
    await user.click(screen.getByRole("button", { name: /^2Gi$/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^2Gi$/i })).toHaveClass("border-primary");
    });
  });

  it("switches between tabs in step 3 and displays correct content", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/modules/builder/scaffold", () => HttpResponse.json(mockScaffoldResponse)),
      http.post("/modules/builder/validate", () => HttpResponse.json(mockValidateResponse)),
      http.post("/modules/builder/preview", () => HttpResponse.json(mockPreviewResponse)),
    );

    renderWithQuery(
      <BuildModuleDialog open onOpenChange={() => undefined} sources={["uploads"]} />
    );

    await user.type(screen.getByPlaceholderText("e.g. cs2-match"), "my-game");
    await user.click(screen.getByRole("button", { name: /Continue to Container & Ports/i }));
    await screen.findByText("Container Image");
    await user.click(screen.getByRole("button", { name: /Continue to Review & Export/i }));
    await screen.findByText("Module Validated Cleanly");

    // Verify module.yaml is initially displayed
    const textareas = screen.getAllByRole("textbox");
    const moduleYamlTextarea = textareas.find((ta) =>
      ta.textContent?.includes("apiVersion: gameplane.local/module")
    ) as HTMLTextAreaElement | undefined;
    expect(moduleYamlTextarea?.value).toContain("apiVersion: gameplane.local/module");

    // Click template.yaml tab
    await user.click(screen.getByRole("button", { name: /template\.yaml/i }));
    const templateTextarea = textareas.find((ta) =>
      ta.textContent?.includes("apiVersion: gameplane.local")
    ) as HTMLTextAreaElement | undefined;
    expect(templateTextarea?.value).toContain("GameTemplate");

    // Click README.md tab
    await user.click(screen.getByRole("button", { name: /README\.md/i }));
    const readmeTextarea = textareas.find((ta) =>
      ta.textContent?.includes("# Test Module")
    ) as HTMLTextAreaElement | undefined;
    expect(readmeTextarea?.value).toContain("# Test Module");
  });

  it("navigates back from step 3 to step 2 and step 2 to step 1", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/modules/builder/scaffold", () => HttpResponse.json(mockScaffoldResponse)),
      http.post("/modules/builder/validate", () => HttpResponse.json(mockValidateResponse)),
      http.post("/modules/builder/preview", () => HttpResponse.json(mockPreviewResponse)),
    );

    renderWithQuery(
      <BuildModuleDialog open onOpenChange={() => undefined} sources={["uploads"]} />
    );

    // Progress to step 3
    await user.type(screen.getByPlaceholderText("e.g. cs2-match"), "my-game");
    await user.click(screen.getByRole("button", { name: /Continue to Container & Ports/i }));
    await screen.findByText("Container Image");
    await user.click(screen.getByRole("button", { name: /Continue to Review & Export/i }));
    await screen.findByText("Memory Simulation");

    // Click back button (from step 3 to step 2)
    await user.click(screen.getByRole("button", { name: /Back/i }));
    await waitFor(() => {
      expect(screen.getByText("Container Image")).toBeInTheDocument();
    });
    expect(screen.queryByText("Memory Simulation")).not.toBeInTheDocument();

    // Click back again (from step 2 to step 1)
    await user.click(screen.getByRole("button", { name: /Back/i }));
    await waitFor(() => {
      expect(screen.getByText("Archetype preset")).toBeInTheDocument();
    });
    expect(screen.queryByText("Container Image")).not.toBeInTheDocument();
  });

  it("shows validation errors in step 2 when required fields are missing", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/modules/builder/archetypes", () =>
        HttpResponse.json({
          archetypes: [
            {
              id: "custom",
              title: "Custom",
              description: "Custom archetype",
              defaultImage: "", // No default image
              defaultPorts: [],
              defaultStorage: { size: "10Gi", mountPath: "/data" },
            },
          ],
        })
      )
    );

    renderWithQuery(
      <BuildModuleDialog open onOpenChange={() => undefined} sources={[]} />
    );

    await screen.findByText("Custom");

    // Try to advance without a valid name
    const continueBtn = screen.getByRole("button", { name: /Continue to Container & Ports/i });
    expect(continueBtn).toBeDisabled(); // No name and archetype has no default image

    // Add invalid name
    await user.type(screen.getByPlaceholderText("e.g. cs2-match"), "INVALID_NAME");
    expect(continueBtn).toBeDisabled();
    expect(screen.getByText(/Must be lowercase/i)).toBeInTheDocument();

    // Fix name to valid format
    const nameInput = screen.getByPlaceholderText("e.g. cs2-match");
    await user.clear(nameInput);
    await user.type(nameInput, "valid-name");
    expect(screen.getByText(/✓ Valid DNS-1123/i)).toBeInTheDocument();

    // Now button is still disabled due to missing image
    expect(continueBtn).toBeDisabled();
  });

  it("displays image pinning validation status in step 2", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/modules/builder/scaffold", () => HttpResponse.json(mockScaffoldResponse)),
      http.post("/modules/builder/validate", () => HttpResponse.json(mockValidateResponse)),
      http.post("/modules/builder/preview", () => HttpResponse.json(mockPreviewResponse)),
    );

    renderWithQuery(
      <BuildModuleDialog open onOpenChange={() => undefined} sources={["uploads"]} />
    );

    await user.type(screen.getByPlaceholderText("e.g. cs2-match"), "my-game");
    await user.click(screen.getByRole("button", { name: /Continue to Container & Ports/i }));
    await screen.findByText("Container Image");

    const imageInput = screen.getByDisplayValue(/^cm2network\/steamcmd:root@sha256:[a-f0-9]{64}$/);

    // Initially shows pinned status (from archetype default)
    expect(screen.getByText(/✓ Pinned by digest/i)).toBeInTheDocument();

    // Change to unpinned image
    await user.clear(imageInput);
    await user.paste("ghcr.io/valgul/game:latest");
    await screen.findByText(/⚠ Unpinned image/i);
    expect(screen.getByText(/recommend @sha256/i)).toBeInTheDocument();

    // Change back to pinned
    await user.clear(imageInput);
    await user.paste("ghcr.io/valgul/game:v1@sha256:" + "a".repeat(64));
    expect(await screen.findByText(/✓ Pinned by digest/i)).toBeInTheDocument();
    expect(imageInput).toHaveValue("ghcr.io/valgul/game:v1@sha256:" + "a".repeat(64));
  });

  it("edits storage size and mount path in step 2", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/modules/builder/scaffold", () => HttpResponse.json(mockScaffoldResponse)),
      http.post("/modules/builder/validate", () => HttpResponse.json(mockValidateResponse)),
      http.post("/modules/builder/preview", () => HttpResponse.json(mockPreviewResponse)),
    );

    renderWithQuery(
      <BuildModuleDialog open onOpenChange={() => undefined} sources={["uploads"]} />
    );

    await user.type(screen.getByPlaceholderText("e.g. cs2-match"), "my-game");
    await user.click(screen.getByRole("button", { name: /Continue to Container & Ports/i }));
    await screen.findByText("Persistent Storage");

    // Find storage inputs
    const storageSizeInput = screen.getByPlaceholderText("e.g. 10Gi");
    const mountPathInput = screen.getByPlaceholderText("e.g. /data");

    // Verify they have default values
    expect(storageSizeInput).toHaveValue("20Gi");
    expect(mountPathInput).toHaveValue("/serverdata");

    // Update storage size
    await user.clear(storageSizeInput);
    await user.type(storageSizeInput, "50Gi");
    expect(storageSizeInput).toHaveValue("50Gi");

    // Update mount path
    await user.clear(mountPathInput);
    await user.type(mountPathInput, "/gamedata");
    expect(mountPathInput).toHaveValue("/gamedata");
  });

  it("shows error when download archive fails", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/modules/builder/scaffold", () => HttpResponse.json(mockScaffoldResponse)),
      http.post("/modules/builder/validate", () => HttpResponse.json(mockValidateResponse)),
      http.post("/modules/builder/preview", () => HttpResponse.json(mockPreviewResponse)),
      http.post("/modules/builder/export", () => {
        return HttpResponse.json({ error: "Network timeout" }, { status: 500 });
      }),
    );

    renderWithQuery(
      <BuildModuleDialog open onOpenChange={() => undefined} sources={["uploads"]} />
    );

    await user.type(screen.getByPlaceholderText("e.g. cs2-match"), "my-game");
    await user.click(screen.getByRole("button", { name: /Continue to Container & Ports/i }));
    await screen.findByText("Container Image");
    await user.click(screen.getByRole("button", { name: /Continue to Review & Export/i }));
    await screen.findByText("Module Validated Cleanly");

    const downloadBtn = screen.getByRole("button", { name: /Download .tar.gz/i });
    await user.click(downloadBtn);

    await screen.findByText(/Network timeout/);
  });

  it("shows error when install to cluster fails", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/modules/builder/scaffold", () => HttpResponse.json(mockScaffoldResponse)),
      http.post("/modules/builder/validate", () => HttpResponse.json(mockValidateResponse)),
      http.post("/modules/builder/preview", () => HttpResponse.json(mockPreviewResponse)),
      http.post("/modules/builder/export", () => {
        return HttpResponse.json({ error: "Permission denied" }, { status: 403 });
      }),
    );

    renderWithQuery(
      <BuildModuleDialog open onOpenChange={() => undefined} sources={["uploads"]} />
    );

    await user.type(screen.getByPlaceholderText("e.g. cs2-match"), "my-game");
    await user.click(screen.getByRole("button", { name: /Continue to Container & Ports/i }));
    await screen.findByText("Container Image");
    await user.click(screen.getByRole("button", { name: /Continue to Review & Export/i }));
    await screen.findByText("Module Validated Cleanly");

    const installBtn = screen.getByRole("button", { name: /Install to Cluster/i });
    await user.click(installBtn);

    await screen.findByText(/Permission denied/);
  });

  it("hides install button when no upload sources exist", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/modules/builder/scaffold", () => HttpResponse.json(mockScaffoldResponse)),
      http.post("/modules/builder/validate", () => HttpResponse.json(mockValidateResponse)),
      http.post("/modules/builder/preview", () => HttpResponse.json(mockPreviewResponse)),
    );

    renderWithQuery(
      <BuildModuleDialog open onOpenChange={() => undefined} sources={[]} />
    );

    await user.type(screen.getByPlaceholderText("e.g. cs2-match"), "my-game");
    await user.click(screen.getByRole("button", { name: /Continue to Container & Ports/i }));
    await screen.findByText("Container Image");
    await user.click(screen.getByRole("button", { name: /Continue to Review & Export/i }));
    await screen.findByText("Module Validated Cleanly");

    // Install button should not be present (lines 962-975 show this conditional)
    expect(screen.queryByRole("button", { name: /Install to Cluster/i })).not.toBeInTheDocument();
    // But download button should still be present
    expect(screen.getByRole("button", { name: /Download .tar.gz/i })).toBeInTheDocument();
  });

  it("handles revalidation error gracefully in step 3", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/modules/builder/scaffold", () => HttpResponse.json(mockScaffoldResponse)),
      http.post("/modules/builder/validate", () => HttpResponse.json(mockValidateResponse)),
      http.post("/modules/builder/preview", () => HttpResponse.json(mockPreviewResponse)),
    );

    renderWithQuery(
      <BuildModuleDialog open onOpenChange={() => undefined} sources={["uploads"]} />
    );

    await user.type(screen.getByPlaceholderText("e.g. cs2-match"), "my-game");
    await user.click(screen.getByRole("button", { name: /Continue to Container & Ports/i }));
    expect(await screen.findByText("Container Image")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Continue to Review & Export/i }));
    expect(await screen.findByText("Module Validated Cleanly")).toBeInTheDocument();

    // Now mock validation failure
    server.use(
      http.post("/modules/builder/validate", () => {
        return HttpResponse.json({ error: "Invalid syntax" }, { status: 400 });
      }),
    );

    // Trigger tab change or editor change
    const textareas = screen.getAllByRole("textbox");
    if (textareas.length > 0) {
      fireEvent.change(textareas[0], { target: { value: "invalid: yaml: [" } });
    }

    await waitFor(() => {
      expect(screen.getByText(/1 errors/i)).toBeInTheDocument();
    });
  });
});

