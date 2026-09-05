import { Clock, Gauge } from "lucide-react";
import type { ReactNode } from "react";

export type CookbookDifficulty = "Beginner" | "Intermediate" | "Advanced";

export interface CookbookMetaProps {
  difficulty: CookbookDifficulty;
  time: string;
  primitives: string[];
}

export const difficultyColor: Record<CookbookDifficulty, string> = {
  Beginner: "text-emerald-600 dark:text-emerald-400",
  Intermediate: "text-amber-600 dark:text-amber-400",
  Advanced: "text-rose-600 dark:text-rose-400",
};

function Pill({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-fd-border bg-fd-card px-2.5 py-1 text-xs font-medium text-fd-card-foreground">
      {icon}
      {children}
    </span>
  );
}

/** A row of at-a-glance badges shown at the top of a cookbook page. */
export function CookbookMeta({ difficulty, time, primitives }: CookbookMetaProps) {
  return (
    <div className="not-prose mb-6 flex flex-wrap items-center gap-2">
      <Pill icon={<Gauge className="size-3.5" />}>
        <span className={difficultyColor[difficulty]}>{difficulty}</span>
      </Pill>
      <Pill icon={<Clock className="size-3.5" />}>{time}</Pill>
      {primitives.map((p) => (
        <Pill key={p}>{p}</Pill>
      ))}
    </div>
  );
}
