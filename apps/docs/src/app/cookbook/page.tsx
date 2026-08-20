import type { Metadata } from "next";
import Link from "next/link";
import { cookbooksSource } from "@/lib/source";

export const metadata: Metadata = {
  title: "Cookbook",
  description: "Task-oriented recipes for building with alineo.",
};

export default function CookbookPage() {
  const recipes = cookbooksSource.getPages().filter((page) => page.slugs.length > 0);

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
        and run yourself.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {recipes.map((recipe) => (
          <Link
            key={recipe.url}
            href={recipe.url}
            className="flex flex-col gap-1 rounded-lg border border-fd-border bg-fd-card p-4 transition-colors hover:border-fd-primary"
          >
            <span className="font-medium text-fd-card-foreground">{recipe.data.title}</span>
            {recipe.data.description && (
              <span className="text-sm text-fd-muted-foreground">{recipe.data.description}</span>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
