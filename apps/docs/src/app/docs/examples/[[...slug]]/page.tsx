import { DocsPage, DocsBody } from "fumadocs-ui/layouts/docs/page";
import { examplesSource } from "@/lib/source";
import { notFound } from "next/navigation";
import { mdxComponents } from "@/lib/mdx-components";
import type { Metadata } from "next";
import { createMetadata } from "@/lib/metadata";
import { DocPageHeader } from "@/components/doc-page-header";
import { DocStructuredData } from "@/components/doc-structured-data";
import { githubSourceUrl, pageMarkdownUrl } from "@/lib/doc-markdown";

const OVERVIEW_SLUGS = new Set([""]);

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = examplesSource.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const slugStr = (slug ?? []).join("/");
  const isOverview = OVERVIEW_SLUGS.has(slugStr);

  return (
    <DocsPage toc={isOverview ? [] : page.data.toc} full={isOverview}>
      <DocStructuredData page={page} tree={examplesSource.pageTree} collection="examples" />
      <DocPageHeader
        title={page.data.title}
        description={page.data.description}
        markdownUrl={pageMarkdownUrl("examples", page.slugs)}
        githubUrl={githubSourceUrl("examples", page.path)}
      />
      <DocsBody>
        <MDX components={mdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = examplesSource.getPage(slug);
  if (!page) return createMetadata({ title: "Not Found" });

  const ogImage = [`/docs-og/examples`, ...(slug ?? []), "image"].join("/");

  return createMetadata({
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
      types: { "text/markdown": pageMarkdownUrl("examples", page.slugs) },
    },
    openGraph: { images: [ogImage] },
    twitter: { images: [ogImage] },
  });
}

export async function generateStaticParams() {
  return examplesSource.getPages().map((page) => ({
    slug: page.slugs,
  }));
}
