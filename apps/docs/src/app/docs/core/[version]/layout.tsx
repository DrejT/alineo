import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { notFound } from "next/navigation";
import { coreVersions } from "@/lib/source";
import { docsTabs } from "@/lib/nav-tabs";
import { docVersions } from "@/lib/doc-versions";
import { VersionSwitcher } from "@/components/version-switcher";

export default async function CoreLayout({
  params,
  children,
}: {
  params: Promise<{ version: string }>;
  children: React.ReactNode;
}) {
  const { version } = await params;
  const source = coreVersions[version as keyof typeof coreVersions];
  if (!source) notFound();

  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{ enabled: true, title: null }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
      tabs={docsTabs}
      sidebar={{
        // Hidden while only one version exists — a dropdown with a single entry
        // has nothing to switch between. Versions come from disk
        // (content/docs/core/vX.Y/, see discoverVersions() in
        // scripts/doc-versions.ts), so this reappears on its own the moment a
        // second version folder is added — nothing here needs editing on a cut.
        banner:
          docVersions.core.versions.length > 1 ? (
            // fumadocs-ui's Sidebar renders `banner` in two subtrees (desktop content +
            // mobile drawer), reusing this same element instance in both — React warns
            // ("each child in a list should have a unique key prop") without an explicit key.
            <VersionSwitcher
              key="core-version-switcher"
              product="core"
              currentVersion={version}
              data={docVersions.core}
            />
          ) : undefined,
      }}
    >
      {children}
    </DocsLayout>
  );
}

export function generateStaticParams() {
  return Object.keys(coreVersions).map((version) => ({ version }));
}

export const dynamicParams = false;
