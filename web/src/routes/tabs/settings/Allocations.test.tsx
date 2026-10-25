import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AllocationsSection } from "./Allocations";
import { makeServer } from "@/test/factories";

function serverWithVoice() {
  const draft = makeServer({
    spec: { templateRef: { name: "x" }, networking: { allocations: [{ name: "voicechat", port: 24455, protocol: "UDP" }, { name: "map", port: 8100 }] } },
  });
  draft.status = { ...draft.status, allocationEndpoints: [{ name: "voicechat", host: "203.0.113.7", port: 24455, protocol: "UDP" }] };
  return draft;
}

describe("AllocationsSection", () => {
  it("shows the empty state", () => {
    render(<AllocationsSection draft={makeServer()} onChange={() => {}} />);
    expect(screen.getByText("No extra ports allocated yet.")).toBeInTheDocument();
  });

  it("lists allocations with their address and status", () => {
    render(<AllocationsSection draft={serverWithVoice()} onChange={() => {}} />);
    expect(screen.getByText("203.0.113.7:24455")).toBeInTheDocument();
    expect(screen.getByText("Assigned")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Waiting for address…")).toBeInTheDocument();
  });

  it("removes an allocation", async () => {
    const onChange = vi.fn();
    render(<AllocationsSection draft={serverWithVoice()} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove map" }));
    expect(onChange.mock.calls.at(-1)![0].spec.networking.allocations).toEqual([{ name: "voicechat", port: 24455, protocol: "UDP" }]);
  });

  it("adds a UDP allocation by default", async () => {
    const onChange = vi.fn();
    render(<AllocationsSection draft={makeServer()} onChange={onChange} />);
    await userEvent.type(screen.getByPlaceholderText("voicechat"), "voice");
    await userEvent.type(screen.getByPlaceholderText("24454"), "24454");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onChange.mock.calls.at(-1)![0].spec.networking.allocations).toEqual([{ name: "voice", port: 24454, protocol: "UDP" }]);
  });

  it("rejects a duplicate name and an out-of-range port", async () => {
    render(<AllocationsSection draft={serverWithVoice()} onChange={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText("voicechat"), "map");
    await userEvent.type(screen.getByPlaceholderText("24454"), "70000");
    expect(screen.getByText("An allocation with this name already exists.")).toBeInTheDocument();
    expect(screen.getByText("Port must be 1–65535.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });
});
