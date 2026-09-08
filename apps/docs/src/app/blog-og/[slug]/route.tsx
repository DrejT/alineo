import { ImageResponse } from "next/og";
import { blogSource } from "@/lib/source";
import { loadOgFonts, ogImageSize, renderOgImage } from "@/lib/og-image";

export const dynamic = "force-static";

export function generateStaticParams() {
  return blogSource.getPages().map((page) => ({ slug: page.slugs[0] }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = blogSource.getPage([slug]);
  const fonts = await loadOgFonts();

  return new ImageResponse(
    renderOgImage(page?.data.title ?? "alineo blog", page?.data.description, "alineo blog"),
    { ...ogImageSize, fonts },
  );
}
