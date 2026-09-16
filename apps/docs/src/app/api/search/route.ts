import { createSearchAPI } from "fumadocs-core/search/server";
import { guideSource, referenceSource, cookbooksSource, playgroundSource } from "@/lib/source";

export const dynamic = "force-static";

const allPages = [
  ...guideSource.getPages(),
  ...referenceSource.getPages(),
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
