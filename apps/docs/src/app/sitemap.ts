import type { MetadataRoute } from "next";
import { coreSource, workflowSource, alineoSource, agentSource } from "@/lib/source";

export const dynamic = "force-static";

const BASE_URL = "https://docs.drej.dev";

export default function sitemap(): MetadataRoute.Sitemap {
  const sources = [coreSource, workflowSource, alineoSource, agentSource];

  const docPages = sources.flatMap((source) =>
    source.getPages().map((page) => ({
      url: `${BASE_URL}${page.url}`,
      lastModified: new Date(),
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  );

  return [
    {
      url: BASE_URL,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 1,
    },
    ...docPages,
  ];
}
