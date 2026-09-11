import { createSearchAPI } from "fumadocs-core/search/server";
import {
  coreSource,
  workflowSource,
  alineoSource,
  agentSource,
  examplesSource,
  playgroundSource,
} from "@/lib/source";

export const dynamic = "force-static";

const allPages = [
  ...coreSource.getPages(),
  ...workflowSource.getPages(),
  ...alineoSource.getPages(),
  ...agentSource.getPages(),
  ...examplesSource.getPages(),
  ...playgroundSource.getPages(),
];

export const { staticGET: GET } = createSearchAPI("advanced", {
  indexes: allPages.map((page) => ({
    id: page.url,
    title: page.data.title,
    description: page.data.description,
    url: page.url,
    structuredData: page.data.structuredData,
  })),
});
