import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ResourcesSection } from "./Resources";
import { makeServer, makeTemplate } from "@/test/factories";

describe("ResourcesSection", () => {
  it("shows 0 for unset request and limit", () => {
    render(<ResourcesSection draft={makeServer()} onChange={() => {}} />);
    expect(screen.getByLabelText("CPU request value")).toHaveValue(0);
    expect(screen.getByLabelText("CPU limit value")).toHaveValue(0);
    expect(screen.getByLabelText("Memory request value")).toHaveValue(0);
    expect(screen.getByLabelText("Memory limit value")).toHaveValue(0);
  });

  it("sets the CPU request without touching the limit", () => {
    const onChange = vi.fn();
    render(<ResourcesSection draft={makeServer()} onChange={onChange} />);
    const input = screen.getByLabelText("CPU request value");
    fireEvent.change(input, { target: { value: "0.5" } });
    fireEvent.blur(input);
    expect(onChange.mock.calls.at(-1)![0].spec.resources).toEqual({ requests: { cpu: "500m" } });
  });

  it("sets the memory limit separately from the request", () => {
    const onChange = vi.fn();
    const draft = { ...makeServer(), spec: { ...makeServer().spec, resources: { requests: { memory: "2Gi" } } } };
    render(<ResourcesSection draft={draft} onChange={onChange} />);
    const input = screen.getByLabelText("Memory limit value");
    fireEvent.change(input, { target: { value: "8" } });
    fireEvent.blur(input);
    expect(onChange.mock.calls.at(-1)![0].spec.resources).toEqual({ requests: { memory: "2Gi" }, limits: { memory: "8Gi" } });
  });

  it("0 removes the value instead of storing it", () => {
    const onChange = vi.fn();
    const draft = { ...makeServer(), spec: { ...makeServer().spec, resources: { requests: { cpu: "1" }, limits: { cpu: "2" } } } };
    render(<ResourcesSection draft={draft} onChange={onChange} />);
    const input = screen.getByLabelText("CPU limit value");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(onChange.mock.calls.at(-1)![0].spec.resources).toEqual({ requests: { cpu: "1" } });
  });

  it("falls back to the template resources when the server has none", () => {
    render(<ResourcesSection draft={makeServer()} onChange={() => {}} template={{ ...makeTemplate(), spec: { ...makeTemplate().spec, resources: { limits: { cpu: "3" } } } }} />);
    expect(screen.getByLabelText("CPU limit value")).toHaveValue(3);
  });

  it("reports invalid when the limit is below the request", () => {
    const onValidityChange = vi.fn();
    const draft = { ...makeServer(), spec: { ...makeServer().spec, resources: { requests: { cpu: "4" }, limits: { cpu: "2" } } } };
    render(<ResourcesSection draft={draft} onChange={() => {}} onValidityChange={onValidityChange} />);
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByText("The limit can't be lower than the request.")).toBeInTheDocument();
  });

  it("keeps storage when resources change", () => {
    const onChange = vi.fn();
    const draft = { ...makeServer(), spec: { ...makeServer().spec, storage: { size: "10Gi" } } };
    render(<ResourcesSection draft={draft} onChange={onChange} />);
    const input = screen.getByLabelText("CPU request value");
    fireEvent.change(input, { target: { value: "8" } });
    fireEvent.blur(input);
    expect(onChange.mock.calls.at(-1)![0].spec.storage.size).toBe("10Gi");
  });

  it("rejects an invalid storage size with an error message", () => {
    const onChange = vi.fn();
    render(
      <ResourcesSection
        draft={{
          ...makeServer(),
          spec: { ...makeServer().spec, storage: { size: "10Pi-bad" } },
        }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText(/Invalid quantity/i)).toBeInTheDocument();
  });

  it("typing valid storage sets spec.storage.size", () => {
    const onChange = vi.fn();
    render(<ResourcesSection draft={makeServer()} onChange={onChange} />);
    const sizeInput = screen.getByPlaceholderText("10Gi");
    fireEvent.change(sizeInput, { target: { value: "20Gi" } });
    const lastCall = onChange.mock.calls.at(-1)![0];
    expect(lastCall.spec.storage.size).toBe("20Gi");
  });

  it("clearing storage size leaves storage undefined", () => {
    const onChange = vi.fn();
    render(
      <ResourcesSection
        draft={{
          ...makeServer(),
          spec: { ...makeServer().spec, storage: { size: "5Gi" } },
        }}
        onChange={onChange}
      />,
    );
    const sizeInput = screen.getByPlaceholderText("10Gi");
    fireEvent.change(sizeInput, { target: { value: "" } });
    const lastCall = onChange.mock.calls.at(-1)![0];
    expect(lastCall.spec.storage).toBeUndefined();
  });

  it("setting storageClassName", () => {
    const onChange = vi.fn();
    render(<ResourcesSection draft={makeServer()} onChange={onChange} />);
    const scInput = screen.getByPlaceholderText("fast-ssd");
    fireEvent.change(scInput, { target: { value: "fast-nvme" } });
    const lastCall = onChange.mock.calls.at(-1)![0];
    expect(lastCall.spec.storage.storageClassName).toBe("fast-nvme");
  });

  it("clearing storageClassName leaves storage undefined if no size", () => {
    const onChange = vi.fn();
    render(
      <ResourcesSection
        draft={{
          ...makeServer(),
          spec: { ...makeServer().spec, storage: { storageClassName: "fast-ssd" } },
        }}
        onChange={onChange}
      />,
    );
    const scInput = screen.getByPlaceholderText("fast-ssd");
    fireEvent.change(scInput, { target: { value: "" } });
    const lastCall = onChange.mock.calls.at(-1)![0];
    expect(lastCall.spec.storage).toBeUndefined();
  });

  it("preserves storage size when setting storageClassName", () => {
    const onChange = vi.fn();
    render(
      <ResourcesSection
        draft={{
          ...makeServer(),
          spec: { ...makeServer().spec, storage: { size: "20Gi" } },
        }}
        onChange={onChange}
      />,
    );
    const scInput = screen.getByPlaceholderText("fast-ssd");
    fireEvent.change(scInput, { target: { value: "fast-nvme" } });
    const lastCall = onChange.mock.calls.at(-1)![0];
    expect(lastCall.spec.storage.size).toBe("20Gi");
    expect(lastCall.spec.storage.storageClassName).toBe("fast-nvme");
  });

  it("renders storage section when storage already set", () => {
    render(
      <ResourcesSection
        draft={{
          ...makeServer(),
          spec: {
            ...makeServer().spec,
            storage: { size: "50Gi", storageClassName: "fast-ssd", mountPath: "/data" },
          },
        }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByDisplayValue("50Gi")).toBeInTheDocument();
    expect(screen.getByDisplayValue("fast-ssd")).toBeInTheDocument();
  });
});
