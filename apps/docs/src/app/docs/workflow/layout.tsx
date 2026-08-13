import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { workflowSource } from "@/lib/source";
import { PackageSwitcher } from "@/components/package-switcher";

export default function WorkflowLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={workflowSource.pageTree}
      nav={{ title: "alineo", url: "/" }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: true }}
      sidebar={{ banner: <PackageSwitcher key="package-switcher" /> }}
    >
      {children}
    </DocsLayout>
  );
}
