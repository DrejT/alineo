import { defineDocs, defineConfig } from "fumadocs-mdx/config";

export const coreDocs = defineDocs({ dir: "content/docs/core" });
export const workflowDocs = defineDocs({ dir: "content/docs/workflow" });
export const alineoDocs = defineDocs({ dir: "content/docs/alineo" });
export const agentDocs = defineDocs({ dir: "content/docs/agent" });

export default defineConfig();
