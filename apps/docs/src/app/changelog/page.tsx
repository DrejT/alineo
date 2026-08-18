import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Release notes for the alineo SDK and CLI.",
};

export default function ChangelogPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-start gap-4 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-[-0.025em] text-fd-foreground">Changelog</h1>
      <p className="text-fd-muted-foreground">
        Coming soon — release notes for the alineo SDK and CLI.
      </p>
    </div>
  );
}
