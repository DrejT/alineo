import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { alineoSource } from "@/lib/source";
import { docsTabs } from "@/lib/nav-tabs";

export default function AlineoLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={alineoSource.pageTree}
      nav={{ enabled: true, title: null }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
      tabs={docsTabs}
    >
      {children}
    </DocsLayout>
  );
}
