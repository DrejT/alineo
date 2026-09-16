import { DocsPage, DocsBody } from "fumadocs-ui/layouts/docs/page";
import { overviewSource } from "@/lib/source";
import { notFound } from "next/navigation";
import { mdxComponents } from "@/lib/mdx-components";
import type { Metadata } from "next";
import { createMetadata } from "@/lib/metadata";
import { DocPageHeader } from "@/components/doc-page-header";
import { DocStructuredData } from "@/components/doc-structured-data";
import { githubSourceUrl, pageMarkdownUrl } from "@/lib/doc-markdown";

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = overviewSource.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc}>
      <DocStructuredData page={page} tree={overviewSource.pageTree} collection="overview" />
      <DocPageHeader
        title={page.data.title}
        description={page.data.description}
        markdownUrl={pageMarkdownUrl("overview", page.slugs)}
        githubUrl={githubSourceUrl("overview", page.path)}
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
  const page = overviewSource.getPage(slug);
  if (!page) return createMetadata({ title: "Not Found" });

  const ogImage = [`/docs-og/overview`, ...(slug ?? []), "image"].join("/");

  return createMetadata({
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
      types: { "text/markdown": pageMarkdownUrl("overview", page.slugs) },
    },
    openGraph: { images: [ogImage] },
    twitter: { images: [ogImage] },
  });
}

export async function generateStaticParams() {
  return overviewSource.getPages().map((page) => ({
    slug: page.slugs,
  }));
}
