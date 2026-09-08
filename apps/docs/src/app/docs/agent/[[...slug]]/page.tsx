import { DocsPage, DocsBody } from "fumadocs-ui/layouts/docs/page";
import { agentSource } from "@/lib/source";
import { notFound } from "next/navigation";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { Steps, Step } from "fumadocs-ui/components/steps";
import type { Metadata } from "next";
import { createMetadata } from "@/lib/metadata";
import { DocPageHeader } from "@/components/doc-page-header";
import { DocStructuredData } from "@/components/doc-structured-data";
import { githubSourceUrl, pageMarkdownUrl } from "@/lib/doc-markdown";

const OVERVIEW_SLUGS = new Set(["", "getting-started", "api-reference"]);

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = agentSource.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const slugStr = (slug ?? []).join("/");
  const isOverview = OVERVIEW_SLUGS.has(slugStr);

  return (
    <DocsPage toc={isOverview ? [] : page.data.toc} full={isOverview}>
      <DocStructuredData page={page} tree={agentSource.pageTree} collection="agent" />
      <DocPageHeader
        title={page.data.title}
        description={page.data.description}
        markdownUrl={pageMarkdownUrl("agent", page.slugs)}
        githubUrl={githubSourceUrl("agent", page.path)}
      />
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents, Steps, Step }} />
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
  const page = agentSource.getPage(slug);
  if (!page) return createMetadata({ title: "Not Found" });

  const ogImage = [`/docs-og/agent`, ...(slug ?? []), "image"].join("/");

  return createMetadata({
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
      types: { "text/markdown": pageMarkdownUrl("agent", page.slugs) },
    },
    openGraph: { images: [ogImage] },
    twitter: { images: [ogImage] },
  });
}

export async function generateStaticParams() {
  return agentSource.getPages().map((page) => ({
    slug: page.slugs,
  }));
}
