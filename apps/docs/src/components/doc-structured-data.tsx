import { getBreadcrumbItems } from "fumadocs-core/breadcrumb";
import type { Root } from "fumadocs-core/page-tree";
import type { ReactNode } from "react";
import type { DocCollection } from "@/lib/doc-markdown";

const SITE = "https://docs.alineo.tech";

interface DocPage {
  url: string;
  data: { title: string; description?: string; lastModified?: Date };
}

/**
 * Per-page `TechArticle` + `BreadcrumbList` JSON-LD. The site-wide `WebSite` object
 * is emitted separately in the root layout; this adds the article-level and
 * navigation context answer engines (Google AI Overviews, Perplexity, Bing) use for
 * attribution and breadcrumb rich results.
 */
export function DocStructuredData({
  page,
  tree,
  collection,
}: {
  page: DocPage;
  tree: Root;
  collection: DocCollection;
}) {
  const sectionUrl = `/docs/${collection}`;
  const sectionName = typeof tree.name === "string" ? tree.name : collection;

  // fumadocs' `includeRoot` only fires on nested root folders, which these collections
  // don't use — so prepend the site root and the section root by hand, then drop the
  // trailing duplicate that appears when the page *is* the section index.
  const chain: { name: ReactNode; url?: string }[] = [
    { name: "alineo docs", url: "/" },
    { name: sectionName, url: sectionUrl },
    ...getBreadcrumbItems(page.url, tree, { includePage: true }),
  ];
  const seen = new Set<string>();
  const crumbs = chain.filter((c) => {
    if (!c.url) return true;
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
  // The current page is always the last crumb — use its article title.
  crumbs[crumbs.length - 1] = { name: page.data.title, url: page.url };

  const itemListElement = crumbs.map((crumb, i) => ({
    "@type": "ListItem" as const,
    position: i + 1,
    name: typeof crumb.name === "string" && crumb.name ? crumb.name : sectionName,
    ...(crumb.url ? { item: `${SITE}${crumb.url}` } : {}),
  }));

  const graph = [
    {
      "@type": "TechArticle",
      headline: page.data.title,
      ...(page.data.description ? { description: page.data.description } : {}),
      url: `${SITE}${page.url}`,
      ...(page.data.lastModified
        ? { dateModified: new Date(page.data.lastModified).toISOString() }
        : {}),
      inLanguage: "en",
      isPartOf: { "@type": "WebSite", name: "alineo docs", url: SITE },
      publisher: { "@type": "Organization", name: "alineo", url: "https://alineo.tech" },
    },
    { "@type": "BreadcrumbList", itemListElement },
  ];

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify({ "@context": "https://schema.org", "@graph": graph }),
      }}
    />
  );
}
