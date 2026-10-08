import { DocsPage, DocsBody } from "fumadocs-ui/layouts/docs/page";
import { cliSource } from "@/lib/source";
import { notFound } from "next/navigation";
import { mdxComponents } from "@/lib/mdx-components";
import type { Metadata } from "next";
import { createMetadata } from "@/lib/metadata";
import { DocPageHeader } from "@/components/doc-page-header";
import { DocStructuredData } from "@/components/doc-structured-data";
import { githubSourceUrl, pageMarkdownUrl } from "@/lib/doc-markdown";

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = cliSource.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc}>
      <DocStructuredData page={page} tree={cliSource.pageTree} collection="cli" />
      <DocPageHeader
        title={page.data.title}
        description={page.data.description}
        markdownUrl={pageMarkdownUrl("cli", page.slugs)}
        githubUrl={githubSourceUrl("cli", page.path)}
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
  const page = cliSource.getPage(slug);
  if (!page) return createMetadata({ title: "Not Found" });

  const ogImage = [`/docs-og/cli`, ...(slug ?? []), "image"].join("/");

  return createMetadata({
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
      types: { "text/markdown": pageMarkdownUrl("cli", page.slugs) },
    },
    openGraph: { images: [ogImage] },
    twitter: { images: [ogImage] },
  });
}

export async function generateStaticParams() {
  return cliSource.getPages().map((page) => ({
    slug: page.slugs,
  }));
}
