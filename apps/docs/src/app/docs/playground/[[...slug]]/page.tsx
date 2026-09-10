import { DocsPage, DocsBody } from "fumadocs-ui/layouts/docs/page";
import { playgroundSource } from "@/lib/source";
import { notFound } from "next/navigation";
import { mdxComponents } from "@/lib/mdx-components";
import type { Metadata } from "next";
import { createMetadata } from "@/lib/metadata";
import { DocPageHeader } from "@/components/doc-page-header";
import { DocStructuredData } from "@/components/doc-structured-data";
import { githubSourceUrl, pageMarkdownUrl } from "@/lib/doc-markdown";
import { PlaygroundConnect } from "@/components/playground/connect";
import { WorkflowRunner } from "@/components/playground/workflow-runner";
import { WorkflowGrid } from "@/components/playground/workflow-grid";

const OVERVIEW_SLUGS = new Set([""]);

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = playgroundSource.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const slugStr = (slug ?? []).join("/");
  const isOverview = OVERVIEW_SLUGS.has(slugStr);

  return (
    <DocsPage toc={isOverview ? [] : page.data.toc} full={isOverview}>
      <DocStructuredData page={page} tree={playgroundSource.pageTree} collection="playground" />
      <DocPageHeader
        title={page.data.title}
        description={page.data.description}
        markdownUrl={pageMarkdownUrl("playground", page.slugs)}
        githubUrl={githubSourceUrl("playground", page.path)}
      />
      <DocsBody>
        <MDX
          components={{
            ...mdxComponents,
            PlaygroundConnect,
            WorkflowRunner,
            WorkflowGrid,
          }}
        />
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
  const page = playgroundSource.getPage(slug);
  if (!page) return createMetadata({ title: "Not Found" });

  const ogImage = [`/docs-og/playground`, ...(slug ?? []), "image"].join("/");

  return createMetadata({
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
      types: { "text/markdown": pageMarkdownUrl("playground", page.slugs) },
    },
    openGraph: { images: [ogImage] },
    twitter: { images: [ogImage] },
  });
}

export async function generateStaticParams() {
  return playgroundSource.getPages().map((page) => ({
    slug: page.slugs,
  }));
}
