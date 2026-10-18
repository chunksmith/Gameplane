import { useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { useOptionalIntl } from "@/lib/i18n/format";

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

const title: Components["h1"] = ({ children }) => <h3 className="text-[15px] font-semibold text-foreground">{children}</h3>;
const subtitle: Components["h1"] = ({ children }) => <h4 className="text-sm font-semibold text-foreground">{children}</h4>;

const components: Components = {
  p: ({ children }) => <p className="whitespace-pre-wrap break-words">{children}</p>,
  h1: title,
  h2: title,
  h3: subtitle,
  h4: subtitle,
  h5: subtitle,
  h6: subtitle,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  del: ({ children }) => <s className="text-muted">{children}</s>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" className="text-link underline underline-offset-2">{children}</a>,
  hr: () => <hr className="border-border" />,
  blockquote: ({ children }) => <blockquote className="space-y-2 border-l-2 border-accent/50 pl-3 text-muted">{children}</blockquote>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5 marker:text-muted">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5 marker:text-muted">{children}</ol>,
  code: ({ children }) => <code className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>,
  pre: ({ children }) => {
    const { className, children: code } = (children as ReactElement<{ className?: string; children?: ReactNode }>).props;
    return <CodeBlock lang={/language-(\S+)/.exec(className ?? "")?.[1] ?? ""} code={String(code).replace(/\n$/, "")} />;
  },
  table: ({ children }) => (
    <div className="overflow-x-auto rounded-xl border border-border scrollbar-thin">
      <table className="w-full border-collapse text-left text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border bg-surface-secondary">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-border last:border-b-0">{children}</tr>,
  th: ({ children }) => <th className="whitespace-nowrap px-3 py-2 font-semibold text-foreground">{children}</th>,
  td: ({ children }) => <td className="whitespace-nowrap px-3 py-2">{children}</td>,
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
}
