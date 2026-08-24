import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { agentSource } from "@/lib/source";
import { docsTabs } from "@/lib/nav-tabs";

export default function AgentLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={agentSource.pageTree}
      nav={{ enabled: true, title: null }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
      tabs={docsTabs}
    >
      {children}
    </DocsLayout>
  );
}
