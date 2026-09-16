import {
  guideDocs,
  referenceDocs,
  cookbooksDocs,
  playgroundDocs,
  blogPosts,
} from "collections/server";
import { loader } from "fumadocs-core/source";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";

export const guideSource = loader({
  baseUrl: "/docs/guide",
  source: guideDocs.toFumadocsSource(),
});

export const referenceSource = loader({
  baseUrl: "/docs/reference",
  source: referenceDocs.toFumadocsSource(),
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
