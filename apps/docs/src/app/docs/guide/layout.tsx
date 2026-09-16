import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { guideSource } from "@/lib/source";
import { docsTabs } from "@/lib/nav-tabs";

export default function GuideLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={guideSource.pageTree}
      nav={{ enabled: true, title: null }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
      tabs={docsTabs}
    >
      {children}
    </DocsLayout>
  );
}
