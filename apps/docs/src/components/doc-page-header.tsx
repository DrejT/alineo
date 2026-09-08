import {
  DocsDescription,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import type { ReactNode } from "react";

/**
 * Docs page title + description with the "Copy Markdown" / "Open in ChatGPT …"
 * actions aligned to the right of the heading (the pattern better-auth.com uses).
 *
 * Wraps fumadocs' `DocsTitle` / `DocsDescription` so the actions share the
 * heading's row on wide viewports and stack under it on narrow ones. The
 * action buttons themselves are fumadocs 16 built-ins.
 */
export function DocPageHeader({
  title,
  description,
  markdownUrl,
  githubUrl,
}: {
  title: ReactNode;
  description?: ReactNode;
  markdownUrl: string;
  githubUrl: string;
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0 flex-1">
        <DocsTitle className="mb-0">{title}</DocsTitle>
        {description && <DocsDescription className="mt-2 mb-0">{description}</DocsDescription>}
      </div>
      <div className="not-prose flex shrink-0 flex-wrap items-center gap-2 md:pt-1">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover markdownUrl={markdownUrl} githubUrl={githubUrl} />
      </div>
    </div>
  );
}
