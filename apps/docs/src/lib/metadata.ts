import type { Metadata } from "next";

export const DEFAULT_DESCRIPTION =
  "Sandboxes as objects. Spawn live containers, run code, checkpoint state — from TypeScript.";

export function createMetadata(override: Metadata): Metadata {
  return {
    ...override,
    openGraph: {
      type: "website",
      siteName: "alineo docs",
      title: override.title ?? undefined,
      description: override.description ?? DEFAULT_DESCRIPTION,
      ...override.openGraph,
    },
    twitter: {
      card: "summary_large_image",
      title: override.title ?? undefined,
      description: override.description ?? DEFAULT_DESCRIPTION,
      ...override.twitter,
    },
  };
}
