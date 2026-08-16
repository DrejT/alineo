import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { workflowSource } from "@/lib/source";
import { docsTabs } from "@/lib/nav-tabs";

export default function WorkflowLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={workflowSource.pageTree}
      nav={{ enabled: true, title: null }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
      tabs={docsTabs}
    >
      {children}
    </DocsLayout>
  );
}
