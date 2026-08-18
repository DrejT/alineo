import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Release notes for the alineo SDK and CLI.",
};

export default function ChangelogPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-start gap-4 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-[-0.025em] text-fd-foreground">Changelog</h1>
      <div className="flex flex-col gap-2 border-l border-fd-border pl-4">
        <span className="text-sm text-fd-muted-foreground">2026-08-18</span>
        <p className="text-fd-foreground">
          Brand favicon parity, per-page SEO metadata, and social preview images for every doc page.
        </p>
      </div>
    </div>
  );
}
