import Link from "next/link";
import { formatBlogDate, type BlogPost } from "@/lib/blog";

/** A single post card — used in the blog index grid and the "More from the blog" footer. */
export function BlogCard({ post }: { post: BlogPost }) {
  return (
    <li className="overflow-hidden rounded-xl border border-fd-border transition-colors hover:border-fd-foreground/25">
      <Link href={post.url} className="group flex h-full flex-col">
        {/* eslint-disable-next-line @next/next/no-img-element -- static export, next/image optimization is off */}
        <img
          src={post.cover}
          alt={post.coverAlt}
          loading="lazy"
          className="aspect-[3/2] w-full border-b border-fd-border object-cover"
          style={{ background: "var(--color-fd-secondary)" }}
        />
        <div className="flex flex-1 flex-col gap-2 p-5">
          <div className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.05em] text-fd-muted-foreground">
            <time dateTime={post.date.toISOString()}>{formatBlogDate(post.date)}</time>
            <span className="text-fd-primary">{post.tag}</span>
          </div>
          <h3 className="text-[16.5px] font-semibold leading-snug tracking-[-0.01em] text-fd-foreground text-balance group-hover:text-fd-primary">
            {post.title}
          </h3>
          <p className="line-clamp-2 text-[13.5px] leading-relaxed text-fd-muted-foreground">
            {post.description}
          </p>
        </div>
      </Link>
    </li>
  );
}
