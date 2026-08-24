import { DocsPage, DocsBody, DocsTitle, DocsDescription } from "fumadocs-ui/layouts/docs/page";
import { coreVersions } from "@/lib/source";
import { notFound } from "next/navigation";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { Steps, Step } from "fumadocs-ui/components/steps";
import type { Metadata } from "next";
import { createMetadata } from "@/lib/metadata";

const OVERVIEW_SLUGS = new Set([
  "",
  "getting-started",
  "concepts",
  "building",
  "patterns",
  "adapters",
  "api-reference",
]);

export default async function Page({
  params,
}: {
  params: Promise<{ version: string; slug?: string[] }>;
}) {
  const { version, slug } = await params;
  const source = coreVersions[version as keyof typeof coreVersions];
  const page = source?.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const slugStr = (slug ?? []).join("/");
  const isOverview = OVERVIEW_SLUGS.has(slugStr);

  return (
    <DocsPage toc={isOverview ? [] : page.data.toc} full={isOverview}>
      <DocsTitle>{page.data.title}</DocsTitle>
      {page.data.description && <DocsDescription>{page.data.description}</DocsDescription>}
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents, Steps, Step }} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ version: string; slug?: string[] }>;
}): Promise<Metadata> {
  const { version, slug } = await params;
  const source = coreVersions[version as keyof typeof coreVersions];
  const page = source?.getPage(slug);
  if (!page) return createMetadata({ title: "Not Found" });

  const ogImage = [`/docs-og/core`, ...(slug ?? []), "image"].join("/");

  return createMetadata({
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: page.url },
    openGraph: { images: [ogImage] },
    twitter: { images: [ogImage] },
  });
}

export function generateStaticParams() {
  return Object.entries(coreVersions).flatMap(([version, source]) =>
    source.getPages().map((page) => ({ version, slug: page.slugs })),
  );
}
