"use client";

import { usePathname, useRouter } from "next/navigation";
import type { VersionedProduct, DocProductVersions } from "@/lib/doc-versions";

// Fumadocs' old built-in RootToggle was removed from the public API in fumadocs-ui
// 16.2, so version switching is hand-rolled here — same approach this app already
// takes for the product switcher (see nav-tabs.tsx's docsTabs). Mounted via
// DocsLayout's `sidebar.banner` slot in core/alineo's [version]/layout.tsx only.
export function VersionSwitcher({
  product,
  currentVersion,
  data,
}: {
  product: VersionedProduct;
  currentVersion: string;
  data: DocProductVersions;
}) {
  const router = useRouter();
  const pathname = usePathname();

  function switchTo(version: string) {
    if (version === currentVersion) return;
    const prefix = `/docs/${product}/${currentVersion}`;
    const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
    router.push(`/docs/${product}/${version}${rest}`);
  }

  if (data.versions.length <= 1) {
    // Only one version exists — a dropdown with a single, unchangeable option is
    // noise. Show the version as a plain label instead; this becomes the real
    // <select> below automatically the moment a second version is cut.
    return (
      <div className="w-full rounded-md border border-fd-border bg-fd-secondary px-2 py-1.5 text-center text-xs font-medium text-fd-muted-foreground">
        {currentVersion}
      </div>
    );
  }

  return (
    <select
      aria-label={`${product} docs version`}
      value={currentVersion}
      onChange={(e) => switchTo(e.target.value)}
      className="w-full rounded-md border border-fd-border bg-fd-secondary px-2 py-1.5 text-xs font-medium text-fd-foreground"
    >
      {data.versions.map((version) => (
        <option key={version} value={version}>
          {version}
          {version === data.latest ? " (latest)" : ""}
        </option>
      ))}
    </select>
  );
}
