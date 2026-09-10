import Link from "next/link";
import { ShieldCheck, ListChecks, Database, GitFork, Bot } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { WORKFLOWS } from "@/lib/playground/workflows";

const ICONS: Record<string, LucideIcon> = {
  "run-untrusted-code": ShieldCheck,
  "ci-test-runner": ListChecks,
  "checkpoint-and-resume": Database,
  "fork-a-sandbox": GitFork,
  "agent-bugfix": Bot,
};

export function WorkflowGrid() {
  return (
    <div className="not-prose grid gap-4 sm:grid-cols-2">
      {WORKFLOWS.map((wf) => {
        const Icon = ICONS[wf.slug] ?? ShieldCheck;
        return (
          <Link
            key={wf.slug}
            href={`/docs/playground/${wf.slug}`}
            className="group flex flex-col gap-3 rounded-lg border border-fd-border bg-fd-card p-4 transition-colors hover:border-fd-primary hover:shadow-sm"
          >
            <div className="flex items-center justify-between">
              <span className="flex size-9 items-center justify-center rounded-md bg-fd-accent text-fd-accent-foreground">
                <Icon className="size-4.5" />
              </span>
              <span className="text-xs text-fd-muted-foreground">{wf.estimate}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="font-medium text-fd-card-foreground group-hover:text-fd-primary">
                {wf.title}
              </span>
              <span className="text-sm text-fd-muted-foreground">{wf.summary}</span>
            </div>
            <div className="mt-auto flex flex-wrap gap-1">
              {wf.primitives.slice(0, 4).map((p) => (
                <span
                  key={p}
                  className="rounded-full border border-fd-border px-1.5 py-0.5 font-mono text-[10px] text-fd-muted-foreground"
                >
                  {p}
                </span>
              ))}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
