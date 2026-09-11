import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { playgroundSource } from "@/lib/source";
import { docsTabs } from "@/lib/nav-tabs";
import { PlaygroundProvider } from "@/lib/playground/connection";

export default function PlaygroundLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={playgroundSource.pageTree}
      nav={{ enabled: true, title: null }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
      tabs={docsTabs}
    >
      <PlaygroundProvider>{children}</PlaygroundProvider>
    </DocsLayout>
  );
}
