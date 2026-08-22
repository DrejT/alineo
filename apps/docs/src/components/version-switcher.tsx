"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Tag } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "fumadocs-ui/components/ui/popover";
import type { VersionedProduct, DocProductVersions } from "@/lib/doc-versions";

// Fumadocs' old built-in RootToggle was removed from the public API in fumadocs-ui
// 16.2, so version switching is hand-rolled here — same approach this app already
// takes for the product switcher (docsTabs -> fumadocs-ui's own SidebarTabsDropdown,
// which this deliberately mirrors visually: a Popover-based trigger, not a native
// <select>, so it reads as the same kind of control). Mounted via DocsLayout's
// `sidebar.banner` slot in core/alineo's [version]/layout.tsx only.
export function VersionSwitcher({
  product,
  currentVersion,
  data,
}: {
  product: VersionedProduct;
  currentVersion: string;
  data: DocProductVersions;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  function switchTo(version: string) {
    setOpen(false);
    if (version === currentVersion) return;
    // Derived from the URL's own segment structure (["", "docs", product, version,
    // ...rest]), not by string-matching pathname against a prefix built from the
    // currentVersion prop — that prefix-match silently falls through to "" (no rest,
    // no error) whenever it's wrong for any reason (stale prop, hydration timing),
    // which previously double-prefixed the target path onto the current one instead
    // of replacing it (e.g. /docs/core/0.2/0.1 instead of /docs/core/0.1). Splitting
    // the real pathname doesn't depend on currentVersion matching anything.
    const rest = pathname.split("/").slice(4).join("/");
    router.push(`/docs/${product}/${version}${rest ? `/${rest}` : ""}`);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex items-center gap-2 rounded-lg border bg-fd-secondary/50 p-2 text-start text-fd-secondary-foreground transition-colors hover:bg-fd-accent data-[state=open]:bg-fd-accent data-[state=open]:text-fd-accent-foreground">
        <Tag className="size-4 shrink-0 text-fd-muted-foreground" />
        <p className="text-sm font-medium">{currentVersion}</p>
        <ChevronsUpDown className="ms-auto size-4 shrink-0 text-fd-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="flex w-(--radix-popover-trigger-width) flex-col gap-1 p-1">
        {data.versions.map((version) => (
          <button
            key={version}
            type="button"
            onClick={() => switchTo(version)}
            className="flex items-center gap-2 rounded-lg p-1.5 text-start hover:bg-fd-accent hover:text-fd-accent-foreground"
          >
            <p className="text-sm font-medium leading-none">
              {version}
              {version === data.latest && (
                <span className="ms-1.5 text-[0.8125rem] font-normal text-fd-muted-foreground">
                  latest
                </span>
              )}
            </p>
            <Check
              className={`ms-auto size-3.5 shrink-0 text-fd-primary ${version === currentVersion ? "" : "invisible"}`}
            />
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
