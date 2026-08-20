import {
  coreV01Docs,
  workflowDocs,
  alineoV01Docs,
  agentDocs,
  examplesDocs,
  cookbooksDocs,
} from "collections/server";
import { loader } from "fumadocs-core/source";

// core and alineo are versioned (see plans/versioned-docs.md). Each entry is a
// fully independent loader() over a frozen content dir — cutting a new version
// never touches an older one. `*LatestVersion` is the single source of truth
// every unversioned link (nav, sitemap, redirects) derives from; bump it as part
// of a version cut and everything downstream follows without a separate edit.
export const coreVersions = {
  "v0.1": loader({ baseUrl: "/docs/core/v0.1", source: coreV01Docs.toFumadocsSource() }),
} as const;
export const coreLatestVersion: keyof typeof coreVersions = "v0.1";
export const coreSource = coreVersions[coreLatestVersion];

export const alineoVersions = {
  "v0.1": loader({ baseUrl: "/docs/alineo/v0.1", source: alineoV01Docs.toFumadocsSource() }),
} as const;
export const alineoLatestVersion: keyof typeof alineoVersions = "v0.1";
export const alineoSource = alineoVersions[alineoLatestVersion];

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
