import { DocsPage, DocsBody } from "fumadocs-ui/layouts/docs/page";
import { cookbooksSource } from "@/lib/source";
import { notFound } from "next/navigation";
import { Tabs, Tab } from "fumadocs-ui/components/tabs";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { mdxComponents } from "@/lib/mdx-components";
import type { Metadata } from "next";
import { createMetadata } from "@/lib/metadata";
import { DocPageHeader } from "@/components/doc-page-header";
import { DocStructuredData } from "@/components/doc-structured-data";
import { githubSourceUrl, pageMarkdownUrl } from "@/lib/doc-markdown";
import { CookbookPlayground } from "@/components/cookbook/playground";
import { CookbookMeta } from "@/components/cookbook/meta";
import { CookbookGrid } from "@/components/cookbook/grid";

const OVERVIEW_SLUGS = new Set([""]);

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = cookbooksSource.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const slugStr = (slug ?? []).join("/");
  const isOverview = OVERVIEW_SLUGS.has(slugStr);

  return (
    <DocsPage toc={isOverview ? [] : page.data.toc} full={isOverview}>
      <DocStructuredData page={page} tree={cookbooksSource.pageTree} collection="cookbooks" />
      <DocPageHeader
        title={page.data.title}
        description={page.data.description}
        markdownUrl={pageMarkdownUrl("cookbooks", page.slugs)}
        githubUrl={githubSourceUrl("cookbooks", page.path)}
      />
      <DocsBody>
        <MDX
          components={{
            ...mdxComponents,
            Tabs,
            Tab,
            Accordion,
            Accordions,
            CookbookPlayground,
            CookbookMeta,
            CookbookGrid,
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
  const page = cookbooksSource.getPage(slug);
  if (!page) return createMetadata({ title: "Not Found" });

  const ogImage = [`/docs-og/cookbooks`, ...(slug ?? []), "image"].join("/");

  return createMetadata({
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
      types: { "text/markdown": pageMarkdownUrl("cookbooks", page.slugs) },
    },
    openGraph: { images: [ogImage] },
    twitter: { images: [ogImage] },
  });
}

export async function generateStaticParams() {
  return cookbooksSource.getPages().map((page) => ({
    slug: page.slugs,
  }));
}
