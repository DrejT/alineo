import type { Metadata } from "next";
import { DocsBody } from "fumadocs-ui/layouts/docs/page";
import { Markdown } from "fumadocs-core/content/md";
import { remarkGfm } from "fumadocs-core/mdx-plugins/remark-gfm";
import { getChangelogEntries } from "@/lib/changelog";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Release notes for the alineo SDK and CLI.",
};

const PACKAGE_LABEL = { alineo: "SDK", "alineo-cli": "CLI" } as const;

export default async function ChangelogPage() {
  const entries = await getChangelogEntries();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-start gap-4 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-[-0.025em] text-fd-foreground">Changelog</h1>
      <div className="flex w-full flex-col gap-8">
        {entries.map((entry) => (
          <div
            key={`${entry.package}-${entry.version}`}
            className="flex flex-col gap-2 border-l border-fd-border pl-4"
          >
            <div className="flex items-center gap-2 text-sm text-fd-muted-foreground">
              <span className="rounded-md border border-fd-border px-1.5 py-0.5 text-xs font-medium">
                {PACKAGE_LABEL[entry.package]}
              </span>
              <span>v{entry.version}</span>
              {entry.date && (
                <span>
                  ·{" "}
                  {new Date(entry.date).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </span>
              )}
            </div>
            <DocsBody>
              <Markdown remarkPlugins={[remarkGfm]}>{entry.body}</Markdown>
            </DocsBody>
          </div>
        ))}
      </div>
    </div>
  );
}
