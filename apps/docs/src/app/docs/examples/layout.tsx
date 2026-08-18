import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { examplesSource } from "@/lib/source";
import { docsTabs } from "@/lib/nav-tabs";

export default function ExamplesLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={examplesSource.pageTree}
      nav={{ enabled: true, title: null }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
      tabs={docsTabs}
    >
      {children}
    </DocsLayout>
  );
}
