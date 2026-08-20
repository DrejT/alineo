import { defineDocs, defineConfig } from "fumadocs-mdx/config";

const docs = { postprocess: { includeProcessedMarkdown: true } };

// core and alineo are versioned (see plans/versioned-docs.md) — one defineDocs per
// published doc version, not per product. Adding a version is: add a defineDocs call
// here, a loader() entry in src/lib/source.ts's version registry, and bump the
// matching *LatestVersion constant. Never rename/remove an existing version's dir —
// it's a frozen snapshot older installs' docs point at.
export const coreV01Docs = defineDocs({ dir: "content/docs/core/v0.1", docs });
export const alineoV01Docs = defineDocs({ dir: "content/docs/alineo/v0.1", docs });
export const workflowDocs = defineDocs({ dir: "content/docs/workflow", docs });
export const agentDocs = defineDocs({ dir: "content/docs/agent", docs });
export const examplesDocs = defineDocs({ dir: "content/docs/examples", docs });

export default defineConfig();
