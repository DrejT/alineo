import {
  overviewDocs,
  coreDocs,
  agentDocs,
  workflowDocs,
  cliDocs,
  alineodDocs,
  cookbooksDocs,
  playgroundDocs,
  blogPosts,
} from "collections/server";
import { loader } from "fumadocs-core/source";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";

export const overviewSource = loader({
  baseUrl: "/docs/overview",
  source: overviewDocs.toFumadocsSource(),
});

export const coreSource = loader({ baseUrl: "/docs/core", source: coreDocs.toFumadocsSource() });

export const agentSource = loader({ baseUrl: "/docs/agent", source: agentDocs.toFumadocsSource() });

export const workflowSource = loader({
  baseUrl: "/docs/workflow",
  source: workflowDocs.toFumadocsSource(),
});

export const cliSource = loader({ baseUrl: "/docs/cli", source: cliDocs.toFumadocsSource() });

export const alineodSource = loader({
  baseUrl: "/docs/alineod",
  source: alineodDocs.toFumadocsSource(),
});

export const cookbooksSource = loader({
  baseUrl: "/docs/cookbooks",
  source: cookbooksDocs.toFumadocsSource(),
});

export const playgroundSource = loader({
  baseUrl: "/docs/playground",
  source: playgroundDocs.toFumadocsSource(),
});

export const blogSource = loader({
  baseUrl: "/blog",
  source: toFumadocsSource(blogPosts, []),
});
