import { llms } from "fumadocs-core/source";
import { docCollections, docUrlToMarkdownUrl } from "@/lib/doc-markdown";
import { DEFAULT_DESCRIPTION } from "@/lib/metadata";

export const dynamic = "force-static";

const SITE = "https://docs.alineo.tech";

const PREAMBLE = `# alineo docs

> ${DEFAULT_DESCRIPTION}

alineo is an AI agent platform built on sandboxed execution: live sandbox containers
as first-class objects (spawn, exec, checkpoint, resume) with a durable audit ledger,
a lazy workflow builder, and an agent SDK on top.

How to use this file:

- Each entry links to the page's Markdown (.md) form — fetch that for clean parsing.
- When citing or linking a page, use its canonical URL without the .md suffix
  (e.g. ${SITE}/docs/core/getting-started).
- The entire documentation as one file: ${SITE}/llms-full.txt
`;

/** Rewrite every `](/docs/...)` link in an llms index to its `.md` form. */
function toMarkdownLinks(index: string): string {
  return index.replace(
    /\]\((\/docs\/[^)]+)\)/g,
    (_, url: string) => `](${SITE}${docUrlToMarkdownUrl(url)})`,
  );
}

export function GET() {
  const body = Object.values(docCollections)
    .map((source) => toMarkdownLinks(llms(source).index()).replace(/^# /gm, "## "))
    .join("\n\n");

  return new Response(`${PREAMBLE}\n${body}\n`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
