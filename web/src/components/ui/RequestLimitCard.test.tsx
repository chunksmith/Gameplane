import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RequestLimitCard, limitBelowRequest, qosClass, quantityAmount, resourcesValid, setResource } from "./RequestLimitCard";

describe("RequestLimitCard helpers", () => {
  it("quantityAmount reads cores and GiB, 0 for unset", () => {
    expect(quantityAmount("cpu", "500m")).toBe(0.5);
    expect(quantityAmount("memory", "512Mi")).toBe(0.5);
    expect(quantityAmount("cpu", undefined)).toBe(0);
    expect(quantityAmount("memory", "0Gi")).toBe(0);
  });

  it("setResource drops zero values and empty sides", () => {
    expect(setResource({ requests: { cpu: "1" } }, "cpu", "requests", "0")).toEqual({});
    expect(setResource({}, "memory", "limits", "4Gi")).toEqual({ limits: { memory: "4Gi" } });
  });

  it("limitBelowRequest only flags a set limit under its request", () => {
    expect(limitBelowRequest({ requests: { cpu: "2" }, limits: { cpu: "1" } }, "cpu")).toBe(true);
    expect(limitBelowRequest({ requests: { cpu: "2" } }, "cpu")).toBe(false);
    expect(resourcesValid({ requests: { memory: "8Gi" }, limits: { memory: "4Gi" } })).toBe(false);
    expect(resourcesValid(undefined)).toBe(true);
  });

  it("qosClass follows Kubernetes rules", () => {
    expect(qosClass(undefined)).toBe("BestEffort");
    expect(qosClass({ limits: { cpu: "2", memory: "4Gi" } })).toBe("Guaranteed");
    expect(qosClass({ requests: { cpu: "2", memory: "4Gi" }, limits: { cpu: "2", memory: "4Gi" } })).toBe("Guaranteed");
    expect(qosClass({ requests: { cpu: "1" }, limits: { cpu: "2", memory: "4Gi" } })).toBe("Burstable");
    expect(qosClass({ requests: { memory: "4Gi" } })).toBe("Burstable");
  });
});

describe("RequestLimitCard", () => {
  it("summarises request and limit", () => {
    render(<RequestLimitCard kind="cpu" resources={{ requests: { cpu: "1" }, limits: { cpu: "2" } }} onChange={vi.fn()} />);
    expect(screen.getByText("Request 1 core of 2 cores limit · Burstable QoS")).toBeInTheDocument();
  });

  it("summarises request only, limit only and none", () => {
    const { rerender } = render(<RequestLimitCard kind="memory" resources={{ requests: { memory: "4Gi" } }} onChange={vi.fn()} />);
    expect(screen.getByText("Request 4 GiB · no limit · Burstable QoS")).toBeInTheDocument();
    rerender(<RequestLimitCard kind="memory" resources={{ limits: { memory: "4Gi" } }} onChange={vi.fn()} />);
    expect(screen.getByText("No request, so Kubernetes uses the 4 GiB limit · Burstable QoS")).toBeInTheDocument();
    rerender(<RequestLimitCard kind="memory" resources={undefined} onChange={vi.fn()} />);
    expect(screen.getByText("No request or limit · BestEffort QoS")).toBeInTheDocument();
  });

  it("shows the error when the limit is below the request", () => {
    render(<RequestLimitCard kind="cpu" resources={{ requests: { cpu: "4" }, limits: { cpu: "2" } }} onChange={vi.fn()} />);
    expect(screen.getByText("The limit can't be lower than the request.")).toBeInTheDocument();
  });

  it("clears the limit with the Remove limit button", () => {
    const onChange = vi.fn();
    render(<RequestLimitCard kind="memory" resources={{ requests: { memory: "5Gi" }, limits: { memory: "6Gi" } }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove limit" }));
    expect(onChange).toHaveBeenCalledWith({ requests: { memory: "5Gi" } });
  });

  it("hides Remove limit when no limit is set", () => {
    render(<RequestLimitCard kind="memory" resources={{ requests: { memory: "5Gi" } }} onChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Remove limit" })).not.toBeInTheDocument();
  });
});
