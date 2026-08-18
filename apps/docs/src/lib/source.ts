import { coreDocs, workflowDocs, alineoDocs, agentDocs, examplesDocs } from "collections/server";
import { loader } from "fumadocs-core/source";

export const coreSource = loader({
  baseUrl: "/docs/core",
  source: coreDocs.toFumadocsSource(),
});

export const workflowSource = loader({
  baseUrl: "/docs/workflow",
  source: workflowDocs.toFumadocsSource(),
});

export const alineoSource = loader({
  baseUrl: "/docs/alineo",
  source: alineoDocs.toFumadocsSource(),
});

export const agentSource = loader({
  baseUrl: "/docs/agent",
  source: agentDocs.toFumadocsSource(),
});

export const examplesSource = loader({
  baseUrl: "/docs/examples",
  source: examplesDocs.toFumadocsSource(),
});
