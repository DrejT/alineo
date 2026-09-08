import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { DocsBody } from "fumadocs-ui/layouts/docs/page";
import { blogSource } from "@/lib/source";
import { mdxComponents } from "@/lib/mdx-components";
import { createMetadata } from "@/lib/metadata";
import { formatBlogDate } from "@/lib/blog";

const SITE = "https://docs.alineo.tech";

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = blogSource.getPage([slug]);
  if (!page) notFound();

  const MDX = page.data.body;
  const date = new Date(page.data.date);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: page.data.title,
    description: page.data.description,
    datePublished: date.toISOString(),
    author: { "@type": "Organization", name: page.data.author },
    publisher: { "@type": "Organization", name: "alineo", url: "https://alineo.tech" },
    mainEntityOfPage: `${SITE}${page.url}`,
    image: `${SITE}/blog-og/${slug}`,
  };

  return (
    <article className="mx-auto w-full max-w-3xl flex-1 px-6 py-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Link href="/blog" className="text-sm text-fd-muted-foreground hover:text-fd-foreground">
        ← Blog
      </Link>
      <h1 className="mt-6 text-3xl font-semibold tracking-[-0.025em] text-fd-foreground">
        {page.data.title}
      </h1>
      <div className="mt-3 text-sm text-fd-muted-foreground">
        <time dateTime={date.toISOString()}>{formatBlogDate(date)}</time> · {page.data.author}
      </div>
      <DocsBody className="mt-10">
        <MDX components={mdxComponents} />
      </DocsBody>
    </article>
  );
}

export function generateStaticParams() {
  return blogSource.getPages().map((page) => ({ slug: page.slugs[0] }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = blogSource.getPage([slug]);
  if (!page) return createMetadata({ title: "Not Found" });

  const ogImage = `/blog-og/${slug}`;

  return createMetadata({
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: `${SITE}${page.url}` },
    openGraph: {
      type: "article",
      publishedTime: new Date(page.data.date).toISOString(),
      images: [ogImage],
    },
    twitter: { images: [ogImage] },
  });
}
