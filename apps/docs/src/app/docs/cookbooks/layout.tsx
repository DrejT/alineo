import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { cookbooksSource } from "@/lib/source";
import { docsTabs } from "@/lib/nav-tabs";

export default function CookbooksLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={cookbooksSource.pageTree}
      nav={{ enabled: true, title: null }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
      tabs={docsTabs}
    >
      {children}
    </DocsLayout>
  );
}
