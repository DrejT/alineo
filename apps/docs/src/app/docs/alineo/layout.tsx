import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { alineoSource } from "@/lib/source";
import { PackageSwitcher } from "@/components/package-switcher";

export default function AlineoLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={alineoSource.pageTree}
      nav={{ title: "alineo", url: "/" }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: true }}
      sidebar={{ banner: <PackageSwitcher key="package-switcher" /> }}
    >
      {children}
    </DocsLayout>
  );
}
