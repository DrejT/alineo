import { MarkdownCopyButton, ViewOptionsPopover } from "fumadocs-ui/layouts/docs/page";

/**
 * "Copy Markdown" + "Open in ChatGPT / Claude / …" actions shown under a docs page
 * title. Thin wrapper over fumadocs' built-in page-action components so all six
 * per-collection doc routes share one import and layout.
 */
export function DocPageActions({
  markdownUrl,
  githubUrl,
}: {
  markdownUrl: string;
  githubUrl: string;
}) {
  return (
    <div className="not-prose mb-6 flex flex-row flex-wrap items-center gap-2">
      <MarkdownCopyButton markdownUrl={markdownUrl} />
      <ViewOptionsPopover markdownUrl={markdownUrl} githubUrl={githubUrl} />
    </div>
  );
}
