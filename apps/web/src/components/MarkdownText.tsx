import { memo, useMemo, type ReactNode } from "react";

interface MarkdownTextProps {
  content: string;
}

type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "blockquote"; text: string }
  | { kind: "code"; language: string; code: string }
  | { kind: "hr" }
  | { kind: "table"; headers: string[]; rows: string[][] };

export const MarkdownText = memo(function MarkdownText({ content }: MarkdownTextProps) {
  const blocks = useMemo(() => parseMarkdown(normalizeLooseMarkdown(content)), [content]);
  if (blocks.length === 0) return null;
  return (
    <div className="markdownText">
      {blocks.map((block, index) => (
        <MarkdownBlock block={block} key={`${block.kind}-${index}`} />
      ))}
    </div>
  );
});

function MarkdownBlock({ block }: { block: Block }) {
  if (block.kind === "heading") {
    const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
    return <Tag>{parseInline(block.text)}</Tag>;
  }
  if (block.kind === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return (
      <Tag>
        {block.items.map((item, index) => (
          <li key={`${item}-${index}`}>{parseInline(item)}</li>
        ))}
      </Tag>
    );
  }
  if (block.kind === "blockquote") {
    return <blockquote>{parseInline(block.text)}</blockquote>;
  }
  if (block.kind === "code") {
    return (
      <pre className="markdownCode" data-language={block.language || undefined}>
        <code>{block.code}</code>
      </pre>
    );
  }
  if (block.kind === "hr") return <hr />;
  if (block.kind === "table") {
    return (
      <div className="markdownTableWrap">
        <table>
          <thead>
            <tr>
              {block.headers.map((header, index) => (
                <th key={`${header}-${index}`}>{parseInline(header)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>
                {block.headers.map((_, cellIndex) => (
                  <td key={`cell-${rowIndex}-${cellIndex}`}>{parseInline(row[cellIndex] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return <p>{parseInline(block.text)}</p>;
}

function parseMarkdown(input: string): Block[] {
  const lines = input.split(/\r?\n/);
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```(?<language>[\w-]*)\s*$/);
    if (fence?.groups) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language: fence.groups["language"] ?? "", code: codeLines.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(?<text>.+)$/);
    if (heading?.groups) {
      blocks.push({ kind: "heading", level: heading[1]!.length as 1 | 2 | 3, text: heading.groups["text"] ?? "" });
      index += 1;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      index += 1;
      continue;
    }

    if (looksLikeTable(lines, index)) {
      const tableLines: string[] = [];
      while (index < lines.length && isTableLine(lines[index] ?? "")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push(parseTable(tableLines));
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(?<text>.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(?<text>.+)$/);
    if (unordered || ordered) {
      const items: string[] = [];
      const isOrdered = Boolean(ordered);
      while (index < lines.length) {
        const item = (isOrdered ? lines[index]?.match(/^\s*\d+[.)]\s+(?<text>.+)$/) : lines[index]?.match(/^\s*[-*]\s+(?<text>.+)$/)) ?? null;
        if (!item?.groups) break;
        items.push(item.groups["text"] ?? "");
        index += 1;
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    if (/^\s*>\s+/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s+/.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^\s*>\s+/, ""));
        index += 1;
      }
      blocks.push({ kind: "blockquote", text: quote.join(" ") });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index]?.trim()) {
      const current = lines[index] ?? "";
      if (/^```/.test(current) || /^#{1,3}\s+/.test(current) || /^\s*---+\s*$/.test(current) || /^\s*[-*]\s+/.test(current) || /^\s*\d+[.)]\s+/.test(current)) break;
      if (looksLikeTable(lines, index)) break;
      paragraph.push(current.trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
}

function parseInline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{parseInline(part.slice(2, -2))}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{parseInline(part.slice(1, -1))}</em>;
    const link = part.match(/^\[(?<label>[^\]]+)\]\((?<href>[^)]+)\)$/);
    if (link?.groups) {
      const href = safeHref(link.groups["href"] ?? "");
      if (!href) return link.groups["label"];
      return (
        <a href={href} key={index} rel="noreferrer" target="_blank">
          {link.groups["label"]}
        </a>
      );
    }
    return part;
  });
}

function safeHref(href: string): string {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("#")) return trimmed;
  return "";
}

function normalizeLooseMarkdown(input: string): string {
  return input
    .replaceAll(" --- ", "\n\n---\n\n")
    .replace(/([^\n])\s+(#{1,3}\s+)/g, "$1\n\n$2")
    .replace(/([^\n])\s+([-*]\s+)/g, "$1\n$2")
    .replace(/\s+\|\s*(?=\d+\s*\|)/g, "\n| ");
}

function looksLikeTable(lines: string[], index: number): boolean {
  const current = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return isTableLine(current) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
}

function isTableLine(line: string): boolean {
  return line.includes("|") && line.split("|").filter((cell) => cell.trim()).length >= 2;
}

function parseTable(lines: string[]): Block {
  const headers = splitTableRow(lines[0] ?? "");
  const rows = lines.slice(2).map(splitTableRow).filter((row) => row.length > 0);
  return { kind: "table", headers, rows };
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}
