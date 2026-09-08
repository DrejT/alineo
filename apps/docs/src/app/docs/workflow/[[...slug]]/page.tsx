import { DocsPage, DocsBody, DocsTitle, DocsDescription } from "fumadocs-ui/layouts/docs/page";
import { workflowSource } from "@/lib/source";
import { notFound } from "next/navigation";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { Steps, Step } from "fumadocs-ui/components/steps";
import type { Metadata } from "next";
import { createMetadata } from "@/lib/metadata";
import { DocPageActions } from "@/components/doc-page-actions";
import { githubSourceUrl, pageMarkdownUrl } from "@/lib/doc-markdown";

const OVERVIEW_SLUGS = new Set(["", "getting-started", "building", "api-reference"]);

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = workflowSource.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const slugStr = (slug ?? []).join("/");
  const isOverview = OVERVIEW_SLUGS.has(slugStr);

  return (
    <DocsPage toc={isOverview ? [] : page.data.toc} full={isOverview}>
      <DocsTitle>{page.data.title}</DocsTitle>
      {page.data.description && <DocsDescription>{page.data.description}</DocsDescription>}
      <DocPageActions
        markdownUrl={pageMarkdownUrl("workflow", page.slugs)}
        githubUrl={githubSourceUrl("workflow", page.path)}
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
  const page = workflowSource.getPage(slug);
  if (!page) return createMetadata({ title: "Not Found" });

  const ogImage = [`/docs-og/workflow`, ...(slug ?? []), "image"].join("/");

  return createMetadata({
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
      types: { "text/markdown": pageMarkdownUrl("workflow", page.slugs) },
    },
    openGraph: { images: [ogImage] },
    twitter: { images: [ogImage] },
  });
}

export async function generateStaticParams() {
  return workflowSource.getPages().map((page) => ({
    slug: page.slugs,
  }));
}
