import { useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { TextArea } from "@heroui/react";
import { FileText, Folder } from "lucide-react";

import { LinearLogo } from "@/components/assistant/LinearLogo";
import { createResourceClient, type FileEntry } from "@/lib/endpoints";
import { Assistant, type AssistantScope, type LinearIssue } from "@/lib/assistant";
import { useOptionalIntl } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

const TYPING = /(?:^|\s)@([^\s@]*)$/;
const LINEAR_TYPING = /(?:^|\s)@linear\s+([A-Za-z][A-Za-z0-9]*-\d*)$/i;
const MENTIONED = /(?:^|\s)@(\S+)/g;
const MAX_OPTIONS = 8;
const LINEAR = "linear";

type Option = { kind: "workspace" } | { kind: "issue"; issue: LinearIssue } | { kind: "file"; entry: FileEntry };

const statusTone: Record<string, string> = { started: "text-warning", completed: "text-success" };

type MentionTextAreaProps = Omit<ComponentProps<typeof TextArea>, "value" | "onChange" | "onKeyDown"> & {
  scope: AssistantScope;
  linear?: boolean;
  value: string;
  onValueChange: (value: string) => void;
  onEnter: () => void;
};

export function MentionTextArea({ scope, linear = false, value, onValueChange, onEnter, ...props }: MentionTextAreaProps) {
  const intl = useOptionalIntl();
  const listId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const before = value.slice(0, caret);
  const term = linear && !closed ? LINEAR_TYPING.exec(before)?.[1] : undefined;
  const query = !closed && term === undefined ? TYPING.exec(before)?.[1] : undefined;
  const fileQuery = scope.server ? query : undefined;
  const workspace = linear && query !== undefined && LINEAR.startsWith(query.toLowerCase());
  const issuesShown = linear && (term !== undefined || query?.toLowerCase() === LINEAR);
  const slash = fileQuery?.lastIndexOf("/") ?? -1;
  const dir = fileQuery && slash >= 0 ? `/${fileQuery.slice(0, slash)}` : "/";
  const needle = fileQuery?.slice(slash + 1).toLowerCase() ?? "";
  const listing = useQuery({
    queryKey: ["ai", "mentions", scope.cluster, scope.namespace, scope.server, dir],
    queryFn: ({ signal }) => clientOf(scope, signal).Files.list(scope.server ?? "", dir, scope.namespace),
    enabled: fileQuery !== undefined,
    staleTime: 30_000,
  });
  const issues = useQuery({ queryKey: ["ai", "linear", "issues"], queryFn: () => Assistant.linearIssues(), enabled: issuesShown, staleTime: 30_000 });
  const issueNeedle = term?.toLowerCase() ?? "";
  const options: Option[] = [
    ...(workspace && term === undefined ? [{ kind: "workspace" } as const] : []),
    ...(issuesShown ? (issues.data ?? []).filter((issue) => issue.id.toLowerCase().startsWith(issueNeedle)).slice(0, MAX_OPTIONS).map((issue) => ({ kind: "issue", issue }) as const) : []),
    ...(fileQuery === undefined ? [] : (listing.data?.entries ?? []).filter((entry) => entry.name.toLowerCase().includes(needle)).slice(0, MAX_OPTIONS).map((entry) => ({ kind: "file", entry }) as const)),
  ];
  const current = Math.min(active, options.length - 1);

  function replace(length: number, insert: string) {
    const start = caret - length;
    const next = start + insert.length;
    onValueChange(value.slice(0, start) + insert + value.slice(caret));
    setCaret(next);
    setActive(0);
    requestAnimationFrame(() => input.current?.setSelectionRange(next, next));
  }

  function pick(option: Option) {
    if (option.kind === "workspace") {
      replace(query?.length ?? 0, `${LINEAR} `);
      setClosed(true);
    } else if (option.kind === "issue") {
      replace(term?.length ?? query?.length ?? 0, `${term === undefined ? `${LINEAR} ` : ""}${option.issue.id} `);
    } else {
      replace(query?.length ?? 0, `${option.entry.path.replace(/^\/+/, "")}${option.entry.dir ? "/" : " "}`);
    }
  }

  function row(option: Option): ReactNode {
    if (option.kind === "workspace") {
      return (
        <>
          <LinearLogo />
          <span className="font-medium text-foreground">{intl.formatMessage({ id: "web.components.assistant.mentions.linear", defaultMessage: "Linear", description: "Assistant mention menu: name of the Linear workspace option; a product name, usually left untranslated" })}</span>
          <span className="truncate text-muted">{intl.formatMessage({ id: "web.components.assistant.mentions.linear_workspace_hint", defaultMessage: "Whole workspace · issues, projects, cycles", description: "Assistant mention menu: text after the Linear option explaining that it gives the assistant the whole Linear workspace" })}</span>
        </>
      );
    }
    if (option.kind === "issue") {
      return (
        <>
          <span className="w-16 shrink-0 font-mono text-muted">{option.issue.id}</span>
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{option.issue.title}</span>
          <span className={cn("hidden shrink-0 text-[11px] sm:inline", statusTone[option.issue.statusType] ?? "text-muted")}>{option.issue.status}</span>
        </>
      );
    }
    return (
      <>
        {option.entry.dir ? <Folder className="h-3.5 w-3.5 shrink-0" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate font-mono">{option.entry.path.replace(/^\/+/, "")}</span>
      </>
    );
  }

  const firstIssue = options.findIndex((option) => option.kind === "issue");

  return (
    <div className="relative">
      {options.length > 0 && (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-96 max-w-full rounded-xl border border-border bg-surface p-1 shadow-lg">
          <ul id={listId} role="listbox" className="max-h-72 overflow-y-auto scrollbar-thin">
            {options.flatMap((option, index) => [
              ...(index === firstIssue
                ? [<li key="issues-heading" role="presentation" className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted">{intl.formatMessage({ id: "web.components.assistant.mentions.recent_issues", defaultMessage: "Recent issues", description: "Assistant mention menu: heading above the recently updated Linear issues; keep it short" })}</li>]
                : []),
              <li
                key={option.kind === "workspace" ? LINEAR : option.kind === "issue" ? option.issue.id : option.entry.path}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === current}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(option);
                }}
                className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs", index === current ? "bg-accent/10 text-accent" : "hover:bg-foreground/5")}
              >
                {row(option)}
              </li>,
            ])}
          </ul>
          {linear && (workspace || issuesShown) && (
            <p className="px-2 pb-1 pt-1.5 text-[11px] text-muted">{intl.formatMessage({ id: "web.components.assistant.mentions.linear_keys_hint", defaultMessage: "↑↓ choose · Enter attaches · type an issue key such as ABC-12 after @linear", description: "Assistant mention menu: keyboard hint under the Linear options; ABC-12 is an example Linear issue key, keep it as it is" })}</p>
          )}
        </div>
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
  const paths = [...new Set([...text.matchAll(MENTIONED)].map((match) => match[1]).filter((mention) => mention.toLowerCase() !== LINEAR))];
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
