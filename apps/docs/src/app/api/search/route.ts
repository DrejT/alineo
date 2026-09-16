import { createSearchAPI } from "fumadocs-core/search/server";
import {
  overviewSource,
  coreSource,
  agentSource,
  workflowSource,
  cliSource,
  alineodSource,
  cookbooksSource,
  playgroundSource,
} from "@/lib/source";

export const dynamic = "force-static";

const allPages = [
  ...overviewSource.getPages(),
  ...coreSource.getPages(),
  ...agentSource.getPages(),
  ...workflowSource.getPages(),
  ...cliSource.getPages(),
  ...alineodSource.getPages(),
  ...cookbooksSource.getPages(),
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
