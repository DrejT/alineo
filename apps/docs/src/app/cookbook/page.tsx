import type { Metadata } from "next";
import { CookbookGrid } from "@/components/cookbook/grid";

export const metadata: Metadata = {
  title: "Cookbook",
  description: "Task-oriented recipes for building with alineo.",
};

export default function CookbookPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-[-0.025em] text-fd-foreground">Cookbook</h1>
      <p className="text-fd-muted-foreground">
        Task-oriented recipes for building with alineo — each one composes several SDK primitives
        (sandboxes, exec, checkpoints, forks, agents) to solve one real end-to-end problem. Every
        recipe is a small, standalone package you can copy out of the{" "}
        <a
          href="https://github.com/DrejT/alineo/tree/main/cookbooks"
          className="text-fd-primary underline decoration-fd-border hover:decoration-fd-primary"
        >
          alineo repo
        </a>{" "}
        and run yourself. Open any recipe for an in-browser preview of what running it looks like,
        plus a step-by-step walkthrough of what's actually happening.
      </p>

      <div className="mt-4">
        <CookbookGrid />
      </div>
    </div>
  );
}
