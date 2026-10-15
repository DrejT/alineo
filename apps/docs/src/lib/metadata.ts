import type { Metadata } from "next";

export const DEFAULT_DESCRIPTION =
  "A control plane for swarms of sandboxed agents. Fork, pause, steer, checkpoint, and replay them, with a durable audit ledger.";

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
