import type { MetadataRoute } from "next";
import {
  coreSource,
  workflowSource,
  alineoSource,
  agentSource,
  examplesSource,
} from "@/lib/source";

export const dynamic = "force-static";

const BASE_URL = "https://docs.alineo.tech";

export default function sitemap(): MetadataRoute.Sitemap {
  const sources = [coreSource, workflowSource, alineoSource, agentSource, examplesSource];

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
    {
      url: `${BASE_URL}/changelog`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/use-cases`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/cookbook`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/faq`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.5,
    },
    ...docPages,
  ];
}
