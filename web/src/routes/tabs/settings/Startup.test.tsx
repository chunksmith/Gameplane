import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResourceTargetProvider, type ServerAccess } from "@/lib/resourceTarget";
import { makeServer, makeTemplate } from "@/test/factories";
import type { GameServer } from "@/types";
import { AIKAR_FLAGS, StartupSection, jvmSizeBytes } from "./Startup";

const WRITER: ServerAccess = { canWrite: true, canControl: true, canConsole: true, canDelete: true, isOwner: true, isCollaborator: false };
const READER: ServerAccess = { ...WRITER, canWrite: false };

const TEMPLATE = makeTemplate({
  spec: {
    configSchema: [
      { name: "INIT_MEMORY", type: "string" },
      { name: "MAX_MEMORY", type: "string", autoFromMemoryLimit: { percent: 75 } },
      { name: "JVM_XX_OPTS", type: "string" },
    ],
  },
});

function server(config?: Record<string, string>): GameServer {
  return makeServer({ spec: { templateRef: { name: "minecraft-vanilla" }, config, resources: { limits: { memory: "4Gi" } } } });
}

function Harness({ initial, access = WRITER, onChange, onValidityChange }: {
  initial: GameServer;
  access?: ServerAccess;
  onChange?: (next: GameServer) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <ResourceTargetProvider target={{ cluster: "local", name: "alpha" }} access={access}>
      <StartupSection
        draft={draft}
        template={TEMPLATE}
        onChange={(next) => {
          setDraft(next);
          onChange?.(next);
        }}
        onValidityChange={onValidityChange}
      />
    </ResourceTargetProvider>
  );
}

const maxHeap = () => screen.getByRole("textbox", { name: /Max heap/ });
const initialHeap = () => screen.getByRole("textbox", { name: /Initial heap/ });
const flags = () => screen.getByRole("textbox", { name: "JVM flags" });

describe("jvmSizeBytes", () => {
  it("parses JVM sizes with optional suffixes and rejects the rest", () => {
    expect(jvmSizeBytes("3G")).toBe(3 * 1024 ** 3);
    expect(jvmSizeBytes(" 512m ")).toBe(512 * 1024 ** 2);
    expect(jvmSizeBytes("1024")).toBe(1024);
    expect(jvmSizeBytes("3GB")).toBeNull();
  });
});

describe("StartupSection", () => {
  it("sizes the heap from the memory limit when the fields are empty", () => {
    const onValidityChange = vi.fn();
    render(<Harness initial={server()} onValidityChange={onValidityChange} />);
    expect(screen.getByText("Saving changes restarts the server so they apply.")).toBeInTheDocument();
    expect(maxHeap()).toHaveAttribute("placeholder", "Auto (3072M)");
    expect(initialHeap()).toHaveAttribute("placeholder", "Same as max (3072M)");
    expect(screen.getByText(/of .* container limit/)).toBeInTheDocument();
    expect(screen.getByText("java -Xms3072M -Xmx3072M -jar server.jar nogui")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "None" })).toHaveAttribute("aria-checked", "true");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it("flags an invalid max heap", () => {
    const onValidityChange = vi.fn();
    render(<Harness initial={server({ MAX_MEMORY: "lots" })} onValidityChange={onValidityChange} />);
    expect(screen.getByText(/Use a whole number with an optional K, M or G suffix/)).toBeInTheDocument();
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("flags an invalid initial heap", () => {
    render(<Harness initial={server({ INIT_MEMORY: "lots", MAX_MEMORY: "2G" })} />);
    expect(screen.getByText(/Use a whole number with an optional K, M or G suffix/)).toBeInTheDocument();
  });

  it("flags an initial heap above the max heap", () => {
    render(<Harness initial={server({ INIT_MEMORY: "3G", MAX_MEMORY: "2G" })} />);
    expect(screen.getByText("Initial heap can't be larger than max heap.")).toBeInTheDocument();
  });

  it("warns when the max heap reaches the memory limit", () => {
    render(<Harness initial={server({ MAX_MEMORY: "4G" })} />);
    expect(screen.getByText(/will be OOM-killed/)).toBeInTheDocument();
  });

  it("writes an edited heap into the config and drops it when cleared", () => {
    const onChange = vi.fn();
    render(<Harness initial={server()} onChange={onChange} />);
    fireEvent.change(maxHeap(), { target: { value: " 2G " } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ spec: expect.objectContaining({ config: { MAX_MEMORY: "2G" } }) }));
    expect(screen.getByText("java -Xms2G -Xmx2G -jar server.jar nogui")).toBeInTheDocument();
    fireEvent.change(maxHeap(), { target: { value: "" } });
    expect(onChange.mock.lastCall?.[0].spec.config).toBeUndefined();
  });

  it("applies flag presets and switches to custom when the flags are edited", async () => {
    const onChange = vi.fn();
    render(<Harness initial={server()} onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "Aikar's flags" }));
    expect(onChange.mock.lastCall?.[0].spec.config).toEqual({ JVM_XX_OPTS: AIKAR_FLAGS });
    expect(screen.getByRole("radio", { name: "Aikar's flags" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "None" }));
    expect(onChange.mock.lastCall?.[0].spec.config).toBeUndefined();
    await userEvent.click(screen.getByRole("radio", { name: "Custom" }));
    expect(screen.getByRole("radio", { name: "Custom" })).toHaveAttribute("aria-checked", "true");
    fireEvent.change(flags(), { target: { value: "-XX:+UseZGC" } });
    expect(onChange.mock.lastCall?.[0].spec.config).toEqual({ JVM_XX_OPTS: "-XX:+UseZGC" });
    expect(screen.getByText("java -Xms3072M -Xmx3072M -XX:+UseZGC -jar server.jar nogui")).toBeInTheDocument();
  });

  it("copies the startup command", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Harness initial={server()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("java -Xms3072M -Xmx3072M -jar server.jar nogui");
  });

  it("is read-only without write access", () => {
    render(<Harness initial={server()} access={READER} />);
    expect(screen.queryByText("Saving changes restarts the server so they apply.")).not.toBeInTheDocument();
    expect(maxHeap()).toBeDisabled();
    expect(initialHeap()).toBeDisabled();
    expect(flags()).toBeDisabled();
  });
});
