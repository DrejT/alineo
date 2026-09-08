import Link from "next/link";
import type { Metadata } from "next";
import { createMetadata } from "@/lib/metadata";
import { formatBlogDate, getBlogPosts, type BlogPost } from "@/lib/blog";

export const metadata: Metadata = createMetadata({
  title: "Blog",
  description:
    "Notes on what we ship in alineo — the sandbox substrate, the agent SDK, and the docs.",
  alternates: {
    canonical: "https://docs.alineo.tech/blog",
    types: { "application/rss+xml": "https://docs.alineo.tech/blog/rss.xml" },
  },
});

function CoverImage({ post, className }: { post: BlogPost; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static export, next/image optimization is off
    <img
      src={post.cover}
      alt={post.coverAlt}
      loading="lazy"
      className={className}
      style={{ background: "var(--color-fd-secondary)" }}
    />
  );
}

function Meta({ post }: { post: BlogPost }) {
  return (
    <div className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.05em] text-fd-muted-foreground">
      <time dateTime={post.date.toISOString()}>{formatBlogDate(post.date)}</time>
      <span className="text-fd-primary">{post.tag}</span>
    </div>
  );
}

export default function BlogIndexPage() {
  const posts = getBlogPosts();
  const [featured, ...rest] = posts;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-14 px-6 py-20">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-[-0.03em] text-fd-foreground">Blog</h1>
        <p className="max-w-[58ch] text-[15px] leading-relaxed text-fd-muted-foreground">
          Notes on what we ship in alineo — the sandbox substrate, the agent SDK, and the docs
          themselves.{" "}
          <a href="/blog/rss.xml" className="text-fd-primary underline decoration-fd-border">
            RSS
          </a>
        </p>
      </header>

      {featured ? (
        <section>
          <span className="mb-4 block font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fd-muted-foreground">
            Latest
          </span>
          <Link
            href={featured.url}
            className="group grid overflow-hidden rounded-xl border border-fd-border transition-colors hover:border-fd-foreground/25 md:grid-cols-[1.1fr_1fr]"
          >
            <CoverImage
              post={featured}
              className="aspect-[3/2] w-full border-b border-fd-border object-cover md:h-full md:border-b-0 md:border-r"
            />
            <div className="flex flex-col justify-center gap-3.5 p-8 md:p-10">
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fd-primary">
                New
              </span>
              <h2 className="text-2xl font-semibold leading-snug tracking-[-0.02em] text-fd-foreground text-balance">
                {featured.title}
              </h2>
              <p className="text-[15px] leading-relaxed text-fd-muted-foreground">
                {featured.description}
              </p>
              <div className="mt-1 flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.03em] text-fd-muted-foreground">
                <time dateTime={featured.date.toISOString()}>{formatBlogDate(featured.date)}</time>
                <span>·</span>
                <span>{featured.author}</span>
              </div>
              <span className="mt-1.5 inline-flex items-center gap-1.5 text-[13.5px] font-medium text-fd-primary">
                Read the post <span aria-hidden>→</span>
              </span>
            </div>
          </Link>
        </section>
      ) : null}

      {rest.length ? (
        <section>
          <span className="mb-4 block font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fd-muted-foreground">
            More posts
          </span>
          <ul className="grid list-none grid-cols-1 gap-5 p-0 sm:grid-cols-2">
            {rest.map((post) => (
              <li
                key={post.url}
                className="overflow-hidden rounded-xl border border-fd-border transition-colors hover:border-fd-foreground/25"
              >
                <Link href={post.url} className="group flex h-full flex-col">
                  <CoverImage
                    post={post}
                    className="aspect-[3/2] w-full border-b border-fd-border object-cover"
                  />
                  <div className="flex flex-1 flex-col gap-2 p-5">
                    <Meta post={post} />
                    <h3 className="text-[16.5px] font-semibold leading-snug tracking-[-0.01em] text-fd-foreground text-balance group-hover:text-fd-primary">
                      {post.title}
                    </h3>
                    <p className="line-clamp-2 text-[13.5px] leading-relaxed text-fd-muted-foreground">
                      {post.description}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
