import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { agentSource } from "@/lib/source";
import { PackageSwitcher } from "@/components/package-switcher";

export default function AgentLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={agentSource.pageTree}
      nav={{ title: "alineo", url: "/" }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: true }}
      sidebar={{ banner: <PackageSwitcher key="package-switcher" /> }}
    >
      {children}
    </DocsLayout>
  );
}
