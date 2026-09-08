import { defineDocs, defineConfig } from "fumadocs-mdx/config";
import lastModified from "fumadocs-mdx/plugins/last-modified";

const docs = { postprocess: { includeProcessedMarkdown: true } };

export const coreDocs = defineDocs({ dir: "content/docs/core", docs });
export const alineoDocs = defineDocs({ dir: "content/docs/alineo", docs });
export const workflowDocs = defineDocs({ dir: "content/docs/workflow", docs });
export const agentDocs = defineDocs({ dir: "content/docs/agent", docs });
export const examplesDocs = defineDocs({ dir: "content/docs/examples", docs });
export const cookbooksDocs = defineDocs({ dir: "content/docs/cookbooks", docs });

// `lastModified` (git commit date per file) feeds the sitemap's <lastmod> and the
// per-page TechArticle `dateModified`. Needs full git history — the docs deploy
// workflow checks out with fetch-depth: 0. Degrades to `undefined` on a shallow
// clone (e.g. CI), which the sitemap handles by omitting <lastmod>.
export default defineConfig({
  plugins: [lastModified()],
});
