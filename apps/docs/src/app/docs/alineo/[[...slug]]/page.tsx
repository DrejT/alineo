import { DocsPage, DocsBody, DocsTitle, DocsDescription } from "fumadocs-ui/layouts/docs/page";
import { alineoSource } from "@/lib/source";
import { notFound } from "next/navigation";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { Steps, Step } from "fumadocs-ui/components/steps";

const OVERVIEW_SLUGS = new Set(["", "getting-started", "commands", "registry"]);

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = alineoSource.getPage(slug);
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

export async function generateStaticParams() {
  return alineoSource.getPages().map((page) => ({
    slug: page.slugs,
  }));
}
