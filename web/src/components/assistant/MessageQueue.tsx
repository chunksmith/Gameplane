import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { CornerDownLeft } from "lucide-react";

import { useOptionalIntl } from "@/lib/i18n/format";

export function useMessageQueue(active: boolean, dispatch: (text: string) => void, interrupt: () => void) {
  const [items, setItems] = useState<string[]>([]);
  const wasActive = useRef(active);
  const drain = () => {
    setItems([]);
    return items;
  };
  const flush = () => dispatch(drain().join("\n\n"));

  useEffect(() => {
    const finished = wasActive.current && !active;
    wasActive.current = active;
    if (finished && items.length > 0) flush();
  });

  return {
    items,
    drain,
    add: (text: string) => setItems((current) => [...current, text]),
    sendNow: () => (active ? interrupt() : flush()),
  };
}

export function QueuedMessages({ items, disabled, onSendNow }: { items: string[]; disabled: boolean; onSendNow: () => void }) {
  const intl = useOptionalIntl();
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col items-end gap-1.5">
      {items.map((text, index) => (
        <p key={index} className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl border border-dashed border-primary/40 px-3 py-1.5 text-sm text-muted">{text}</p>
      ))}
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>{intl.formatMessage({ id: "web.components.assistant.message_queue.queued", defaultMessage: "Queued: sends when the current reply finishes", description: "Assistant chat: muted note under messages typed while Claude is still working, saying they are sent once the current reply ends" })}</span>
        <Button size="sm" variant="ghost" isDisabled={disabled} onPress={onSendNow}>
          <CornerDownLeft className="h-3.5 w-3.5" /> {intl.formatMessage({ id: "web.components.assistant.message_queue.send_now", defaultMessage: "Send now", description: "Assistant chat: button under queued messages that stops Claude's current reply and sends them right away; keep it short" })}
        </Button>
      </div>
    </div>
  );
}
