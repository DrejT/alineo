import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { referenceSource } from "@/lib/source";
import { docsTabs } from "@/lib/nav-tabs";

export default function ReferenceLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={referenceSource.pageTree}
      nav={{ enabled: true, title: null }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
      tabs={docsTabs}
    >
      {children}
    </DocsLayout>
  );
}
