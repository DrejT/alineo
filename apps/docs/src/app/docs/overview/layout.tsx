import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { overviewSource } from "@/lib/source";

/**
 * No product switcher here on purpose. The overview sits above the products
 * rather than beside them, and its own "The pieces" cards are the way into each
 * one — showing the switcher with nothing selected would just look broken.
 */
export default function OverviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={overviewSource.pageTree}
      nav={{ enabled: true, title: null }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
    >
      {children}
    </DocsLayout>
  );
}
