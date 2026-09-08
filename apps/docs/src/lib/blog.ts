import { blogSource } from "@/lib/source";

export interface BlogPost {
  url: string;
  slug: string;
  title: string;
  description: string;
  date: Date;
  author: string;
}

/** All blog posts, newest first. */
export function getBlogPosts(): BlogPost[] {
  return blogSource
    .getPages()
    .map((page) => ({
      url: page.url,
      slug: page.slugs[0],
      title: page.data.title,
      description: page.data.description,
      date: new Date(page.data.date),
      author: page.data.author,
    }))
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

export function formatBlogDate(date: Date): string {
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}
