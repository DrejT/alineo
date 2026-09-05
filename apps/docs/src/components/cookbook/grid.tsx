import Link from "next/link";
import { cookbooksMeta } from "@/lib/cookbooks-meta";
import { difficultyColor } from "./meta";

export interface CookbookGridProps {
  /** Base path each card links to — the slug is appended. */
  basePath?: string;
}

/** The full cookbook listing as a grid of cards — shared by `/cookbook` and `/docs/cookbooks`. */
export function CookbookGrid({ basePath = "/docs/cookbooks" }: CookbookGridProps) {
  return (
    <div className="not-prose grid gap-4 sm:grid-cols-2">
      {cookbooksMeta.map(({ slug, title, description, difficulty, time, icon: Icon }) => (
        <Link
          key={slug}
          href={`${basePath}/${slug}`}
          className="group flex flex-col gap-3 rounded-lg border border-fd-border bg-fd-card p-4 transition-colors hover:border-fd-primary hover:shadow-sm"
        >
          <div className="flex items-center justify-between">
            <span className="flex size-9 items-center justify-center rounded-md bg-fd-accent text-fd-accent-foreground">
              <Icon className="size-4.5" />
            </span>
            <span className={`text-xs font-medium ${difficultyColor[difficulty]}`}>
              {difficulty}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-medium text-fd-card-foreground group-hover:text-fd-primary">
              {title}
            </span>
            <span className="text-sm text-fd-muted-foreground">{description}</span>
          </div>
          <span className="mt-auto text-xs text-fd-muted-foreground">{time}</span>
        </Link>
      ))}
    </div>
  );
}
