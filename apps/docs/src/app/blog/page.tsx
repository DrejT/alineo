import Link from "next/link";
import type { Metadata } from "next";
import { createMetadata } from "@/lib/metadata";
import { formatBlogDate, getBlogPosts } from "@/lib/blog";

export const metadata: Metadata = createMetadata({
  title: "Blog",
  description: "Updates and notes from the alineo team.",
  alternates: {
    canonical: "https://docs.alineo.tech/blog",
    types: { "application/rss+xml": "https://docs.alineo.tech/blog/rss.xml" },
  },
});

export default function BlogIndexPage() {
  const posts = getBlogPosts();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-24">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-[-0.025em] text-fd-foreground">Blog</h1>
        <p className="text-fd-muted-foreground">
          Updates and notes from the alineo team.{" "}
          <a href="/blog/rss.xml" className="underline decoration-fd-border">
            RSS
          </a>
        </p>
      </header>

      <div className="flex flex-col divide-y divide-fd-border">
        {posts.map((post) => (
          <Link key={post.url} href={post.url} className="group flex flex-col gap-1.5 py-5">
            <time className="text-xs text-fd-muted-foreground" dateTime={post.date.toISOString()}>
              {formatBlogDate(post.date)}
            </time>
            <span className="text-lg font-medium text-fd-foreground group-hover:text-fd-primary">
              {post.title}
            </span>
            <span className="text-sm text-fd-muted-foreground">{post.description}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
