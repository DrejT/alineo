import { docCollections, docUrlToMarkdownUrl } from "@/lib/doc-markdown";

export const dynamic = "force-static";

const SITE = "https://docs.alineo.tech";

interface StructuredData {
  headings?: { id: string; content: string }[];
  contents?: { heading?: string; content: string }[];
}

/**
 * A flat, machine-readable index of every docs page — title, description, headings,
 * and section text, plus the canonical and Markdown URLs. Cheaper for an agent to
 * pull than crawling HTML, and a companion to `/llms.txt` (which is a link index)
 * and `/api/search` (the Orama search bundle).
 */
export function GET() {
  const pages = Object.values(docCollections).flatMap((source) => source.getPages());

  const index = pages.map((page) => {
    const structured = (page.data as { structuredData?: StructuredData }).structuredData ?? {};
    return {
      url: `${SITE}${page.url}`,
      markdownUrl: `${SITE}${docUrlToMarkdownUrl(page.url)}`,
      title: page.data.title,
      description: page.data.description ?? "",
      headings: (structured.headings ?? []).map((h) => h.content),
      sections: (structured.contents ?? []).map((c) => ({
        heading: c.heading ?? null,
        content: c.content,
      })),
    };
  });

  return new Response(JSON.stringify({ site: SITE, pages: index }, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
