import { coreVersions, coreLatestVersion, alineoVersions, alineoLatestVersion } from "@/lib/source";

// Display-friendly reshaping of the version registries in source.ts, for components
// (the version switcher, an eventual "you're viewing an old version" banner) that
// only need version labels/ordering — not the fumadocs loader()/pageTree machinery
// itself. source.ts's registries stay the single source of truth; this just re-derives
// from them, so there's nothing to keep in sync by hand.
export interface DocProductVersions {
  versions: string[];
  latest: string;
}

export const docVersions = {
  core: { versions: Object.keys(coreVersions), latest: coreLatestVersion } as DocProductVersions,
  alineo: {
    versions: Object.keys(alineoVersions),
    latest: alineoLatestVersion,
  } as DocProductVersions,
} as const satisfies Record<string, DocProductVersions>;

export type VersionedProduct = keyof typeof docVersions;
