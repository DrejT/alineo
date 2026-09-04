import { defineDocs, defineConfig } from "fumadocs-mdx/config";

const docs = { postprocess: { includeProcessedMarkdown: true } };

export const coreDocs = defineDocs({ dir: "content/docs/core", docs });
export const alineoDocs = defineDocs({ dir: "content/docs/alineo", docs });
export const workflowDocs = defineDocs({ dir: "content/docs/workflow", docs });
export const agentDocs = defineDocs({ dir: "content/docs/agent", docs });
export const examplesDocs = defineDocs({ dir: "content/docs/examples", docs });
export const cookbooksDocs = defineDocs({ dir: "content/docs/cookbooks", docs });

export default defineConfig();
