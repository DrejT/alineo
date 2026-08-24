import { ImageResponse } from "next/og";
import {
  coreSource,
  workflowSource,
  alineoSource,
  agentSource,
  examplesSource,
  cookbooksSource,
} from "@/lib/source";
import { loadOgFonts, ogImageSize, renderOgImage } from "@/lib/og-image";

const SOURCES = {
  core: coreSource,
  workflow: workflowSource,
  alineo: alineoSource,
  agent: agentSource,
  examples: examplesSource,
  cookbooks: cookbooksSource,
} as const;

type Collection = keyof typeof SOURCES;

// Every page's slug path is followed by a fixed trailing "image" segment (mirroring the pattern
// fumadocs' own docs site uses for this exact reason): a category page and its children share a
// URL prefix (e.g. "agent/getting-started" is both a real page and a directory of deeper pages),
// so a static-export file can't be named identically to a sibling directory. Appending a constant
// leaf segment — never a real content slug (verified: no content path is literally "image") —
// keeps every emitted file at a distinct, always-a-leaf path.
export const dynamic = "force-static";

export async function generateStaticParams() {
  return (Object.keys(SOURCES) as Collection[]).flatMap((collection) =>
    SOURCES[collection].getPages().map((page) => ({
      collection,
      slug: [...page.slugs, "image"],
    })),
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ collection: string; slug: string[] }> },
) {
  const { collection, slug } = await params;
  const source = SOURCES[collection as Collection] as (typeof SOURCES)[Collection] | undefined;
  const page = source?.getPage(slug.slice(0, -1));
  const fonts = await loadOgFonts();

  return new ImageResponse(
    renderOgImage(page?.data.title ?? "alineo docs", page?.data.description),
    {
      ...ogImageSize,
      fonts,
    },
  );
}
