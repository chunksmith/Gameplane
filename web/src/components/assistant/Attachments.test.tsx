import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { AttachButton, AttachmentTray, MessageAttachments, isAttachment, useAttachments } from "./Attachments";

const textFile = () => new File(["a: 1"], "config.yml", { type: "" });
const imageFile = () => new File(["png"], "shot.png", { type: "image/png" });

describe("useAttachments", () => {
  it("encodes added files and removes or clears them", async () => {
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.add([textFile(), imageFile()]));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.items[0]).toEqual({ name: "config.yml", mediaType: "application/octet-stream", data: btoa("a: 1") });
    expect(result.current.items[1]).toMatchObject({ name: "shot.png", mediaType: "image/png", data: btoa("png") });
    act(() => result.current.remove(0));
    expect(result.current.items.map((item) => item.name)).toEqual(["shot.png"]);
    act(() => result.current.clear());
    expect(result.current.items).toEqual([]);
  });

  it("keeps at most five attachments", async () => {
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.add(Array.from({ length: 7 }, textFile)));
    await waitFor(() => expect(result.current.items).toHaveLength(5));
  });

  it("takes pasted files and leaves plain text pastes alone", async () => {
    const { result } = renderHook(() => useAttachments());
    const plain = { clipboardData: { files: [] }, preventDefault: vi.fn() };
    act(() => result.current.onPaste(plain as never));
    expect(plain.preventDefault).not.toHaveBeenCalled();
    const pasted = { clipboardData: { files: [imageFile()] }, preventDefault: vi.fn() };
    act(() => result.current.onPaste(pasted as never));
    expect(pasted.preventDefault).toHaveBeenCalled();
    await waitFor(() => expect(result.current.items).toHaveLength(1));
  });
});

describe("AttachButton", () => {
  it("passes picked files on", () => {
    const onFiles = vi.fn();
    const { container } = render(<AttachButton onFiles={onFiles} />);
    expect(screen.getByRole("button", { name: "Attach files or images" })).toBeInTheDocument();
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    const file = textFile();
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFiles).toHaveBeenCalledWith([file]);
  });
});

describe("AttachmentTray", () => {
  it("renders nothing when empty", () => {
    const { container } = render(<AttachmentTray items={[]} onRemove={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows image previews and file chips that can be removed", () => {
    const onRemove = vi.fn();
    render(
      <AttachmentTray
        items={[
          { name: "shot.webp", mediaType: "image/webp", data: "AAAA" },
          { name: "notes.txt", mediaType: "text/plain", data: "AAAA" },
        ]}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByRole("img", { name: "Attached image shot.webp" })).toHaveAttribute("src", "data:image/webp;base64,AAAA");
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    expect(onRemove).toHaveBeenCalledWith(1);
  });
});

describe("MessageAttachments", () => {
  it("renders image and document blocks of a message", () => {
    render(
      <MessageAttachments
        blocks={[
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "document", title: "server.yml", source: { type: "text", data: "a: 1" } },
        ]}
      />,
    );
    expect(screen.getByRole("img")).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(screen.getByText("server.yml")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders nothing without attachments", () => {
    const { container } = render(<MessageAttachments blocks={[{ type: "text", text: "hi" }]} />);
    expect(container).toBeEmptyDOMElement();
    expect(isAttachment({ type: "document" })).toBe(true);
    expect(isAttachment({ type: "text" })).toBe(false);
  });
});
