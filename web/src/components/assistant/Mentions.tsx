import { useId, useRef, useState, type ComponentProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { TextArea } from "@heroui/react";
import { FileText, Folder } from "lucide-react";

import { createResourceClient, type FileEntry } from "@/lib/endpoints";
import type { AssistantScope } from "@/lib/assistant";
import { cn } from "@/lib/utils";

const TYPING = /(?:^|\s)@([^\s@]*)$/;
const MENTIONED = /(?:^|\s)@(\S+)/g;
const MAX_OPTIONS = 8;

type MentionTextAreaProps = Omit<ComponentProps<typeof TextArea>, "value" | "onChange" | "onKeyDown"> & {
  scope: AssistantScope;
  value: string;
  onValueChange: (value: string) => void;
  onEnter: () => void;
};

export function MentionTextArea({ scope, value, onValueChange, onEnter, ...props }: MentionTextAreaProps) {
  const listId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const query = scope.server && !closed ? TYPING.exec(value.slice(0, caret))?.[1] : undefined;
  const slash = query?.lastIndexOf("/") ?? -1;
  const dir = query && slash >= 0 ? `/${query.slice(0, slash)}` : "/";
  const needle = query?.slice(slash + 1).toLowerCase() ?? "";
  const listing = useQuery({
    queryKey: ["ai", "mentions", scope.cluster, scope.namespace, scope.server, dir],
    queryFn: ({ signal }) => clientOf(scope, signal).Files.list(scope.server ?? "", dir, scope.namespace),
    enabled: query !== undefined,
    staleTime: 30_000,
  });
  const options = query === undefined ? [] : (listing.data?.entries ?? []).filter((entry) => entry.name.toLowerCase().includes(needle)).slice(0, MAX_OPTIONS);
  const current = Math.min(active, options.length - 1);

  function pick(entry: FileEntry) {
    const start = caret - (query?.length ?? 0);
    const insert = `${entry.path.replace(/^\/+/, "")}${entry.dir ? "/" : " "}`;
    const next = start + insert.length;
    onValueChange(value.slice(0, start) + insert + value.slice(caret));
    setCaret(next);
    setActive(0);
    requestAnimationFrame(() => input.current?.setSelectionRange(next, next));
  }

  return (
    <div className="relative">
      {options.length > 0 && (
        <ul id={listId} role="listbox" className="absolute bottom-full left-0 z-20 mb-2 max-h-64 w-72 max-w-full overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg scrollbar-thin">
          {options.map((entry, index) => (
            <li
              key={entry.path}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === current}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(entry);
              }}
              className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs", index === current ? "bg-accent/10 text-accent" : "hover:bg-foreground/5")}
            >
              {entry.dir ? <Folder className="h-3.5 w-3.5 shrink-0" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
              <span className="truncate font-mono">{entry.path.replace(/^\/+/, "")}</span>
            </li>
          ))}
        </ul>
      )}
      <TextArea
        {...props}
        ref={input}
        value={value}
        aria-autocomplete="list"
        aria-controls={options.length > 0 ? listId : undefined}
        aria-activedescendant={options.length > 0 ? `${listId}-${current}` : undefined}
        onChange={(event) => {
          onValueChange(event.target.value);
          setCaret(event.target.selectionStart);
          setClosed(false);
          setActive(0);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          if (options.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive((current + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              pick(options[current]);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setClosed(true);
              return;
            }
          }
          if (event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          onEnter();
        }}
      />
    </div>
  );
}

export async function mentionContext(scope: AssistantScope, text: string): Promise<string> {
  const server = scope.server;
  if (!server) return "";
  const client = clientOf(scope);
  const paths = [...new Set([...text.matchAll(MENTIONED)].map((match) => match[1]))];
  const parts = await Promise.all(
    paths.map(async (mention) => {
      const path = `/${mention.replace(/^\/+|\/+$/g, "")}`;
      try {
        if (mention.endsWith("/")) {
          const { entries } = await client.Files.list(server, path, scope.namespace);
          return `Folder ${path}:\n${entries.map((entry) => (entry.dir ? `${entry.name}/` : entry.name)).join("\n")}`;
        }
        return `File ${path}:\n\`\`\`\n${await client.Files.read(server, path, scope.namespace)}\n\`\`\``;
      } catch {
        return "";
      }
    }),
  );
  const found = parts.filter(Boolean);
  return found.length ? `The user mentioned these files and folders with @:\n\n${found.join("\n\n")}` : "";
}

function clientOf(scope: AssistantScope, signal?: AbortSignal) {
  return createResourceClient({ cluster: scope.cluster ?? "local", namespace: scope.namespace }, signal);
}
