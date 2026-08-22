import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { notFound } from "next/navigation";
import { alineoVersions } from "@/lib/source";
import { docsTabs } from "@/lib/nav-tabs";

export default async function AlineoLayout({
  params,
  children,
}: {
  params: Promise<{ version: string }>;
  children: React.ReactNode;
}) {
  const { version } = await params;
  const source = alineoVersions[version as keyof typeof alineoVersions];
  if (!source) notFound();

  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{ enabled: true, title: null }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
      tabs={docsTabs}
      // sidebar.banner (VersionSwitcher) hidden for now — see core's [version]/layout.tsx.
    >
      {children}
    </DocsLayout>
  );
}

export function generateStaticParams() {
  return Object.keys(alineoVersions).map((version) => ({ version }));
}

export const dynamicParams = false;
