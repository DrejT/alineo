import {
  coreSource,
  workflowSource,
  agentSource,
  alineoSource,
  examplesSource,
  cookbooksSource,
} from "@/lib/source";

/**
 * Docs collections keyed by the first path segment after `/docs/`. Shared by the
 * per-page raw-markdown route (`/llms.mdx/...`) and the "Copy Markdown" /
 * "Open in ChatGPT" page actions next to each page title.
 */
export const docCollections = {
  core: coreSource,
  workflow: workflowSource,
  agent: agentSource,
  alineo: alineoSource,
  examples: examplesSource,
  cookbooks: cookbooksSource,
} as const;

export type DocCollection = keyof typeof docCollections;

const GITHUB_CONTENT_BASE = "https://github.com/DrejT/alineo/blob/main/apps/docs/content/docs";

/** GitHub URL of the MDX source file backing a docs page (`page.path` is content-dir relative). */
export function githubSourceUrl(collection: DocCollection, pagePath: string) {
  return `${GITHUB_CONTENT_BASE}/${collection}/${pagePath}`;
}

/**
 * Static-export route segments for a docs page's raw markdown.
 *
 * The trailing `.md` on the last segment is load-bearing: `next build`'s static
 * export writes every Route Handler to a file, and a bare `/llms.mdx/core/adapters`
 * file would collide with the `adapters/` directory holding its child pages. The
 * `.md` suffix keeps every emitted file at a leaf path (same trick `docs-og` uses
 * with its trailing `image` segment).
 */
export function markdownSlugSegments(collection: DocCollection, slugs: string[]) {
  const segments = [collection, ...slugs];
  segments[segments.length - 1] += ".md";
  return segments;
}

/** Public URL of the raw-markdown route for a docs page. */
export function pageMarkdownUrl(collection: DocCollection, slugs: string[]) {
  return `/llms.mdx/${markdownSlugSegments(collection, slugs).join("/")}`;
}

/**
 * Rewrite a docs page URL (`/docs/core/adapters/postgres`) to its raw-markdown URL
 * (`/llms.mdx/core/adapters/postgres.md`). Used to point llms.txt entries at clean
 * Markdown instead of HTML.
 */
export function docUrlToMarkdownUrl(url: string): string {
  const rest = url.replace(/^\/docs\//, "").replace(/\/+$/, "");
  const segments = rest.split("/");
  segments[segments.length - 1] += ".md";
  return `/llms.mdx/${segments.join("/")}`;
}

/** Resolve a `/llms.mdx/...` slug back to its collection and page slugs. */
export function parseMarkdownSlug(
  slug: string[],
): { collection: DocCollection; pageSlugs: string[] } | null {
  if (slug.length === 0) return null;
  const stripped = [...slug];
  stripped[stripped.length - 1] = stripped[stripped.length - 1].replace(/\.md$/, "");
  const [collection, ...pageSlugs] = stripped;
  if (!(collection in docCollections)) return null;
  return { collection: collection as DocCollection, pageSlugs };
}
