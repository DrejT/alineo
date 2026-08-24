import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { notFound } from "next/navigation";
import { coreVersions } from "@/lib/source";
import { docsTabs } from "@/lib/nav-tabs";
// import { docVersions } from "@/lib/doc-versions";
// import { VersionSwitcher } from "@/components/version-switcher";

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
      // Version dropdown (sidebar.banner) commented out for now — re-enable by
      // uncommenting this block plus the docVersions/VersionSwitcher imports above.
      // sidebar={{
      //   banner: (
      //     <VersionSwitcher
      //       key="core-version-switcher"
      //       product="core"
      //       currentVersion={version}
      //       data={docVersions.core}
      //     />
      //   ),
      // }}
    >
      {children}
    </DocsLayout>
  );
}

export function generateStaticParams() {
  return Object.keys(coreVersions).map((version) => ({ version }));
}

export const dynamicParams = false;
