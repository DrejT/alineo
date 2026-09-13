import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { alineodSource } from "@/lib/source";
import { docsTabs } from "@/lib/nav-tabs";

export default function AlineodLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={alineodSource.pageTree}
      nav={{ enabled: true, title: null }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
      tabs={docsTabs}
    >
      {children}
    </DocsLayout>
  );
}
