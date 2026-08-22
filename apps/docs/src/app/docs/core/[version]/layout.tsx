import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { notFound } from "next/navigation";
import { coreVersions } from "@/lib/source";
import { docsTabs } from "@/lib/nav-tabs";

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
      // sidebar.banner (VersionSwitcher) hidden for now — only one version exists,
      // so a dropdown with a single entry has nothing useful to switch between.
      // Re-add via `sidebar={{ banner: <VersionSwitcher ... /> }}` once v0.2 ships;
      // see core/[version]/layout.tsx's git history for the exact prior wiring.
    >
      {children}
    </DocsLayout>
  );
}

export function generateStaticParams() {
  return Object.keys(coreVersions).map((version) => ({ version }));
}

export const dynamicParams = false;
