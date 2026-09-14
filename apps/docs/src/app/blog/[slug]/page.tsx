import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { DocsBody } from "fumadocs-ui/layouts/docs/page";
import { blogSource } from "@/lib/source";
import { mdxComponents } from "@/lib/mdx-components";
import { createMetadata } from "@/lib/metadata";
import { formatBlogDate, getBlogPosts } from "@/lib/blog";
import { BlogCard } from "@/components/blog-card";
import { BlogToc } from "@/components/blog-toc";

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
    image: page.data.cover ? `${SITE}${page.data.cover}` : `${SITE}/blog-og/${slug}`,
  };

  const cover = page.data.cover;
  const otherPosts = getBlogPosts()
    .filter((post) => post.slug !== slug)
    .slice(0, 3);

  return (
    <div className="flex-1">
      <div className="mx-auto grid w-full max-w-[1200px] grid-cols-1 gap-x-12 px-6 py-24 xl:grid-cols-[1fr_48rem_1fr]">
        <article className="mx-auto w-full max-w-3xl xl:col-start-2">
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
          <div className="mt-3 flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.05em] text-fd-muted-foreground">
            <time dateTime={date.toISOString()}>{formatBlogDate(date)}</time>
            <span className="text-fd-primary">{page.data.tag}</span>
            <span>·</span>
            <span>{page.data.author}</span>
          </div>
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element -- static export, next/image optimization is off
            <img
              src={cover}
              alt={page.data.coverAlt ?? page.data.title}
              className="mt-8 w-full rounded-xl border border-fd-border"
            />
          ) : null}
          <DocsBody className="mt-10">
            <MDX components={mdxComponents} />
          </DocsBody>
        </article>
        <BlogToc toc={page.data.toc} />
      </div>

      {otherPosts.length ? (
        <div className="mx-auto w-full max-w-5xl px-6 pb-24">
          <span className="mb-4 block font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fd-muted-foreground">
            More from the blog
          </span>
          <ul className="grid list-none grid-cols-1 gap-5 p-0 sm:grid-cols-3">
            {otherPosts.map((post) => (
              <BlogCard key={post.url} post={post} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
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
