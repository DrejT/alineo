"use client";

import type { TOCItemType } from "fumadocs-core/toc";
import { TOCProvider, TOCScrollArea, useTOCItems } from "fumadocs-ui/components/toc";
import { TOCEmpty, TOCItem, TOCItems } from "fumadocs-ui/components/toc/default";

/**
 * A sticky right-rail table of contents for a single blog post. Built from fumadocs' TOC
 * primitives directly (not the `DocsPage`/`TOC` slot component) — that slot positions itself
 * with `[grid-area:toc]` and CSS vars (`--fd-docs-row-*`) that only exist inside a `DocsLayout`,
 * which the blog doesn't use.
 */
export function BlogToc({ toc }: { toc: TOCItemType[] }) {
  if (toc.length === 0) return null;

  return (
    <TOCProvider toc={toc}>
      <div className="sticky top-24 hidden max-h-[calc(100vh-7rem)] w-56 shrink-0 flex-col gap-3 xl:col-start-3 xl:flex">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fd-muted-foreground">
          On this page
        </span>
        <TOCScrollArea className="flex-1 overflow-y-auto pe-2">
          <TocList />
        </TOCScrollArea>
      </div>
    </TOCProvider>
  );
}

function TocList() {
  const items = useTOCItems();
  return (
    <TOCItems>
      {items.length === 0 && <TOCEmpty />}
      {items.map((item) => (
        <TOCItem key={item.url} item={item} />
      ))}
    </TOCItems>
  );
}
