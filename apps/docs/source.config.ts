import { defineDocs, defineConfig, defineCollections } from "fumadocs-mdx/config";
import lastModified from "fumadocs-mdx/plugins/last-modified";
import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins/remark-mdx-mermaid";
import { z } from "zod";

const docs = { postprocess: { includeProcessedMarkdown: true } };

export const coreDocs = defineDocs({ dir: "content/docs/core", docs });
export const alineoDocs = defineDocs({ dir: "content/docs/alineo", docs });
export const workflowDocs = defineDocs({ dir: "content/docs/workflow", docs });
export const agentDocs = defineDocs({ dir: "content/docs/agent", docs });
export const examplesDocs = defineDocs({ dir: "content/docs/examples", docs });
export const cookbooksDocs = defineDocs({ dir: "content/docs/cookbooks", docs });
export const playgroundDocs = defineDocs({ dir: "content/docs/playground", docs });

export const blogPosts = defineCollections({
  type: "doc",
  dir: "content/blog",
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    author: z.string().default("The alineo team"),
    /** Section label on the card and post header. */
    tag: z.enum(["Product", "Engineering", "Docs"]).default("Product"),
    /**
     * Card / hero image — an absolute path under `/blog-assets/<slug>/`. May be a `.png`,
     * `.gif`, `.jpg`, or `.webp`. Falls back to the generated `/blog-og/<slug>` image on
     * the index card when unset.
     */
    cover: z.string().optional(),
    coverAlt: z.string().optional(),
  }),
});

// `lastModified` (git commit date per file) feeds the sitemap's <lastmod> and the
// per-page TechArticle `dateModified`. Needs full git history — the docs deploy
// workflow checks out with fetch-depth: 0. Degrades to `undefined` on a shallow
// clone (e.g. CI), which the sitemap handles by omitting <lastmod>.
export default defineConfig({
  plugins: [lastModified()],
  // Turn ```mermaid fences into <Mermaid /> (registered in src/lib/mdx-components.tsx).
  mdxOptions: {
    preset: "fumadocs",
    remarkPlugins: (v) => [remarkMdxMermaid, ...v],
    // Keep image `src` as a plain string path (served from /blog-assets/*) instead of a
    // static import wrapped in next/image — this is a static export with no image optimizer,
    // and blog covers/GIFs want to be served as-is. `img` is a plain <img> (mdx-components).
    remarkImageOptions: { useImport: false },
  },
});
