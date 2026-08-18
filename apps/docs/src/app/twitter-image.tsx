import { ImageResponse } from "next/og";
import { DEFAULT_DESCRIPTION } from "@/lib/metadata";
import { loadOgFonts, ogImageContentType, ogImageSize, renderOgImage } from "@/lib/og-image";

export const dynamic = "force-static";
export const size = ogImageSize;
export const contentType = ogImageContentType;
export const alt = "alineo docs";

export default async function Image() {
  const fonts = await loadOgFonts();
  return new ImageResponse(renderOgImage("alineo docs", DEFAULT_DESCRIPTION), { ...size, fonts });
}
