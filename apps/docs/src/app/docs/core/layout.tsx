import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { coreSource } from "@/lib/source";
import { PackageSwitcher } from "@/components/package-switcher";

export default function CoreLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={coreSource.pageTree}
      nav={{ title: "alineo", url: "/" }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: true }}
      sidebar={{ banner: <PackageSwitcher key="package-switcher" /> }}
    >
      {children}
    </DocsLayout>
  );
}
