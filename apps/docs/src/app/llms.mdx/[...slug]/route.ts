import { notFound } from "next/navigation";
import { getLLMText } from "@/lib/get-llm-text";
import {
  docCollections,
  markdownSlugSegments,
  parseMarkdownSlug,
  type DocCollection,
} from "@/lib/doc-markdown";

export const dynamic = "force-static";

export function generateStaticParams() {
  return (Object.keys(docCollections) as DocCollection[]).flatMap((collection) =>
    docCollections[collection]
      .getPages()
      .map((page) => ({ slug: markdownSlugSegments(collection, page.slugs) })),
  );
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const parsed = parseMarkdownSlug(slug);
  if (!parsed) notFound();

  const page = docCollections[parsed.collection].getPage(parsed.pageSlugs);
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
