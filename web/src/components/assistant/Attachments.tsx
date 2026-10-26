import { useRef, useState, type ClipboardEvent } from "react";
import { Button } from "@heroui/react";
import { FileText, Paperclip, X } from "lucide-react";
import { defineMessages } from "react-intl";

import { useOptionalIntl } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";
import type { AssistantAttachment, AssistantBlock } from "@/lib/assistant";

const MAX_ATTACHMENTS = 5;
const IMAGE_EDGE = 1568;
const RESIZED = ["image/png", "image/jpeg", "image/webp"];

const MESSAGES = defineMessages({
  attach: { id: "web.components.assistant.attachments.attach", defaultMessage: "Attach files or images", description: "Assistant message box: icon-only paperclip button that picks files or screenshots to send with the message; read by screen readers; keep it short" },
});

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? file), "image/webp", 0.9));
}

async function encode(file: File): Promise<AssistantAttachment> {
  const blob = RESIZED.includes(file.type) ? await shrink(file).catch(() => file) : file;
  return { name: file.name, mediaType: blob.type || "application/octet-stream", data: await readBase64(blob) };
}

export function useAttachments() {
  const [items, setItems] = useState<AssistantAttachment[]>([]);
  const add = (files: Iterable<File>) => {
    void Promise.all([...files].map(encode)).then((added) => setItems((current) => [...current, ...added].slice(0, MAX_ATTACHMENTS))).catch(() => undefined);
  };
  const onPaste = (event: ClipboardEvent) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    add(files);
  };
  return { items, add, onPaste, remove: (index: number) => setItems((current) => current.filter((_, i) => i !== index)), clear: () => setItems([]) };
}

export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const intl = useOptionalIntl();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      <Button isIconOnly size="sm" variant="ghost" aria-label={intl.formatMessage(MESSAGES.attach)} isDisabled={disabled} onPress={() => input.current?.click()}>
        <Paperclip className="h-4 w-4" />
      </Button>
    </>
  );
}

function Thumb({ name, src, onRemove }: { name: string; src?: string; onRemove?: () => void }) {
  const intl = useOptionalIntl();
  return (
    <li className="relative">
      {src ? (
        <a href={src} target="_blank" rel="noreferrer">
          <img src={src} alt={intl.formatMessage({ id: "web.components.assistant.attachments.image", defaultMessage: "Attached image {name}", description: "Assistant chat: alternative text of an image the user attached to a message; {name} is the file name" }, { name })} className="h-16 w-16 rounded-lg border border-border object-cover" />
        </a>
      ) : (
        <span className="flex h-16 max-w-40 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-xs">
          <FileText className="h-4 w-4 shrink-0 text-muted" />
          <span className="truncate">{name}</span>
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "web.components.assistant.attachments.remove", defaultMessage: "Remove {name}", description: "Assistant message box: icon-only button on an attached file that removes it before sending; {name} is the file name; read by screen readers" }, { name })}
          onClick={onRemove}
          className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-surface p-0.5 text-muted hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </li>
  );
}

const imageSrc = (mediaType: string, data: string) => `data:${mediaType};base64,${data}`;

export function AttachmentTray({ items, onRemove }: { items: AssistantAttachment[]; onRemove: (index: number) => void }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2 px-1 pb-2 pt-1.5">
      {items.map((item, index) => (
        <Thumb key={index} name={item.name} src={item.mediaType.startsWith("image/") ? imageSrc(item.mediaType, item.data) : undefined} onRemove={() => onRemove(index)} />
      ))}
    </ul>
  );
}

export function isAttachment(block: AssistantBlock): boolean {
  return block.type === "image" || block.type === "document";
}

export function MessageAttachments({ blocks, className }: { blocks: AssistantBlock[]; className?: string }) {
  const attached = blocks.filter(isAttachment);
  if (attached.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap justify-end gap-2", className)}>
      {attached.map((block, index) => (
        <Thumb
          key={index}
          name={block.title ?? ""}
          src={block.type === "image" && block.source?.data ? imageSrc(block.source.media_type ?? "image/png", block.source.data) : undefined}
        />
      ))}
    </ul>
  );
}
