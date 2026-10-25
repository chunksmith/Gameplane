import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { QueuedMessages, useMessageQueue } from "./MessageQueue";

function setup(active: boolean) {
  const dispatch = vi.fn();
  const interrupt = vi.fn();
  const hook = renderHook(({ busy }) => useMessageQueue(busy, dispatch, interrupt), { initialProps: { busy: active } });
  return { ...hook, dispatch, interrupt };
}

describe("useMessageQueue", () => {
  it("sends queued messages together once the run finishes", () => {
    const { result, rerender, dispatch } = setup(true);
    act(() => result.current.add("first"));
    act(() => result.current.add("second"));
    expect(result.current.items).toEqual(["first", "second"]);
    expect(dispatch).not.toHaveBeenCalled();
    rerender({ busy: false });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("first\n\nsecond");
    expect(result.current.items).toEqual([]);
  });

  it("does not send when idle without a finished run", () => {
    const { result, rerender, dispatch } = setup(false);
    act(() => result.current.add("waiting"));
    rerender({ busy: false });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.current.items).toEqual(["waiting"]);
  });

  it("interrupts the run on send now while active", () => {
    const { result, dispatch, interrupt } = setup(true);
    act(() => result.current.add("urgent"));
    act(() => result.current.sendNow());
    expect(interrupt).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("sends right away on send now while idle", () => {
    const { result, dispatch, interrupt } = setup(false);
    act(() => result.current.add("stuck"));
    act(() => result.current.sendNow());
    expect(interrupt).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("stuck");
    expect(result.current.items).toEqual([]);
  });

  it("drains the queue without sending", () => {
    const { result, rerender, dispatch } = setup(true);
    act(() => result.current.add("keep me"));
    let drained: string[] = [];
    act(() => {
      drained = result.current.drain();
    });
    expect(drained).toEqual(["keep me"]);
    rerender({ busy: false });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("QueuedMessages", () => {
  it("renders nothing for an empty queue", () => {
    const { container } = render(<QueuedMessages items={[]} disabled={false} onSendNow={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists queued messages and sends them now", () => {
    const onSendNow = vi.fn();
    render(<QueuedMessages items={["one", "two"]} disabled={false} onSendNow={onSendNow} />);
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("two")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Send now/ }));
    expect(onSendNow).toHaveBeenCalledOnce();
  });

  it("disables send now while a request is pending", () => {
    render(<QueuedMessages items={["one"]} disabled onSendNow={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Send now/ })).toBeDisabled();
  });
});
