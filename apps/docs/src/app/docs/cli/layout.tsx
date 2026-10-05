import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { cliSource } from "@/lib/source";
import { docsTabs } from "@/lib/nav-tabs";

export default function CliLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={cliSource.pageTree}
      nav={{ enabled: true, title: null }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
      tabs={docsTabs}
    >
      {children}
    </DocsLayout>
  );
}
