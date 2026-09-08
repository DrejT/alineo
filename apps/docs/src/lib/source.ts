import {
  coreDocs,
  alineoDocs,
  workflowDocs,
  agentDocs,
  examplesDocs,
  cookbooksDocs,
  blogPosts,
} from "collections/server";
import { loader } from "fumadocs-core/source";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";

export const coreSource = loader({ baseUrl: "/docs/core", source: coreDocs.toFumadocsSource() });

export const alineoSource = loader({
  baseUrl: "/docs/alineo",
  source: alineoDocs.toFumadocsSource(),
});

export const workflowSource = loader({
  baseUrl: "/docs/workflow",
  source: workflowDocs.toFumadocsSource(),
});

export const agentSource = loader({
  baseUrl: "/docs/agent",
  source: agentDocs.toFumadocsSource(),
});

export const examplesSource = loader({
  baseUrl: "/docs/examples",
  source: examplesDocs.toFumadocsSource(),
});

export const cookbooksSource = loader({
  baseUrl: "/docs/cookbooks",
  source: cookbooksDocs.toFumadocsSource(),
});

export const blogSource = loader({
  baseUrl: "/blog",
  source: toFumadocsSource(blogPosts, []),
});
