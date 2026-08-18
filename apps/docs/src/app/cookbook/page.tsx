import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cookbook",
  description: "Task-oriented recipes for building with alineo.",
};

export default function CookbookPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-[-0.025em] text-fd-foreground">Cookbook</h1>
      <p className="text-fd-muted-foreground">
        Coming soon — task-oriented recipes for building with alineo.
      </p>
    </div>
  );
}
