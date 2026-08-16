import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { coreSource } from "@/lib/source";
import { docsTabs } from "@/lib/nav-tabs";

export default function CoreLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={coreSource.pageTree}
      nav={{ enabled: true, title: null }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
      tabs={docsTabs}
    >
      {children}
    </DocsLayout>
  );
}
