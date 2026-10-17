import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useOptionalIntl } from "@/lib/i18n/format";

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|~~([^~]+)~~|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    const [whole, code, strong, strongAlt, em, strike, label, href] = match;
    if (at > last) out.push(text.slice(last, at));
    last = at + whole.length;
    if (code !== undefined) {
      out.push(<code key={at} className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[0.85em]">{code}</code>);
    } else if (strong !== undefined || strongAlt !== undefined) {
      out.push(<strong key={at} className="font-semibold">{strong ?? strongAlt}</strong>);
    } else if (em !== undefined) {
      out.push(<em key={at}>{em}</em>);
    } else if (strike !== undefined) {
      out.push(<s key={at} className="text-muted">{strike}</s>);
    } else {
      out.push(<a key={at} href={href} target="_blank" rel="noreferrer" className="text-link underline underline-offset-2">{label}</a>);
    }
  }
  out.push(text.slice(last));
  return out;
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const intl = useOptionalIntl();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface-secondary">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">{lang || intl.formatMessage({ id: "web.components.assistant.markdown.plain_text", defaultMessage: "text", description: "Markdown code block: label above a code block that has no language, shown in uppercase; keep it short" })}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied
            ? intl.formatMessage({ id: "web.components.assistant.markdown.copied", defaultMessage: "Copied", description: "Markdown code block: accessible name of the copy button after the code was copied; keep it short" })
            : intl.formatMessage({ id: "web.components.assistant.markdown.copy_code", defaultMessage: "Copy code", description: "Markdown code block: accessible name of the button that copies the code to the clipboard; keep it short" })}
          className="rounded-md p-1 text-muted transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed scrollbar-thin"><code>{code}</code></pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(<p key={out.length} className="whitespace-pre-wrap break-words">{inline(paragraph.join("\n"))}</p>);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^ {0,3}```\s*(\S*)/.exec(line);
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    const item = bullet ?? /^\s*\d+[.)]\s+(.+)$/.exec(line);

    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^ {0,3}```/.test(lines[i]); i++) body.push(lines[i]);
      out.push(<CodeBlock key={out.length} lang={fence[1]} code={body.join("\n")} />);
    } else if (heading) {
      flush();
      const Tag = heading[1].length <= 2 ? "h3" : "h4";
      const size = heading[1].length <= 2 ? "text-[15px]" : "text-sm";
      out.push(<Tag key={out.length} className={`${size} font-semibold text-foreground`}>{inline(heading[2])}</Tag>);
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push(<hr key={out.length} className="border-border" />);
    } else if (quote) {
      flush();
      const body = [quote[1]];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) body.push(lines[++i].replace(/^>\s?/, ""));
      out.push(<blockquote key={out.length} className="border-l-2 border-accent/50 pl-3 text-muted">{inline(body.join("\n"))}</blockquote>);
    } else if (item) {
      flush();
      const ordered = !bullet;
      const pattern = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
      const items = [item[1]];
      for (let next = pattern.exec(lines[i + 1] ?? ""); next; next = pattern.exec(lines[i + 1] ?? "")) {
        items.push(next[1]);
        i++;
      }
      const nodes = items.map((entry, index) => <li key={index}>{inline(entry)}</li>);
      out.push(ordered
        ? <ol key={out.length} className="list-decimal space-y-1 pl-5 marker:text-muted">{nodes}</ol>
        : <ul key={out.length} className="list-disc space-y-1 pl-5 marker:text-muted">{nodes}</ul>);
    } else if (line.trim() === "") {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return <div className="space-y-3 text-sm leading-relaxed">{out}</div>;
}
