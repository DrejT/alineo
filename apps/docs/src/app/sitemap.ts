import type { MetadataRoute } from "next";
import { docCollections } from "@/lib/doc-markdown";
import { getChangelogEntries } from "@/lib/changelog";

export const dynamic = "force-static";

const BASE_URL = "https://docs.alineo.tech";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const docPages: MetadataRoute.Sitemap = Object.values(docCollections).flatMap((source) =>
    source.getPages().map((page) => {
      const lastModified = (page.data as { lastModified?: Date }).lastModified;
      return {
        url: `${BASE_URL}${page.url}`,
        ...(lastModified ? { lastModified } : {}),
        changeFrequency: "weekly" as const,
        priority: 0.8,
      };
    }),
  );

  const changelogEntries = await getChangelogEntries();
  const changelogUpdated = changelogEntries.find((e) => e.date)?.date;

  return [
    { url: BASE_URL, changeFrequency: "monthly", priority: 1 },
    {
      url: `${BASE_URL}/changelog`,
      ...(changelogUpdated ? { lastModified: new Date(changelogUpdated) } : {}),
      changeFrequency: "weekly",
      priority: 0.5,
    },
    { url: `${BASE_URL}/cookbook`, changeFrequency: "weekly", priority: 0.5 },
    { url: `${BASE_URL}/faq`, changeFrequency: "weekly", priority: 0.5 },
    ...docPages,
  ];
}
