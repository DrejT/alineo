import { Bug, Brain, Database, GitFork, KeyRound, ListChecks, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CookbookDifficulty } from "@/components/cookbook/meta";

export interface CookbookMetaEntry {
  slug: string;
  title: string;
  description: string;
  difficulty: CookbookDifficulty;
  time: string;
  icon: LucideIcon;
}

/**
 * Single source of truth for the cookbook listing pages (`/cookbook` and `/docs/cookbooks`) —
 * keep this in sync with each recipe's `<CookbookMeta>` call in `content/docs/cookbooks/*.mdx`.
 */
export const cookbooksMeta: CookbookMetaEntry[] = [
  {
    slug: "untrusted-code-execution",
    title: "Untrusted Code Execution",
    description:
      "Safely run LLM-generated or user-submitted code — per-snippet isolation, resource caps, and timeouts.",
    difficulty: "Beginner",
    time: "~5 min",
    icon: ShieldCheck,
  },
  {
    slug: "ci-test-runner",
    title: "CI Test Runner",
    description:
      "Run a repo's test suite in a disposable sandbox and turn the output into a structured pass/fail report.",
    difficulty: "Beginner",
    time: "~5 min",
    icon: ListChecks,
  },
  {
    slug: "parallel-test-shards",
    title: "Parallel Test Shards",
    description:
      "Install dependencies once, then fork into parallel sandboxes to shard work across them.",
    difficulty: "Intermediate",
    time: "~5 min",
    icon: GitFork,
  },
  {
    slug: "resumable-etl-pipeline",
    title: "Resumable ETL Pipeline",
    description:
      "A multi-stage pipeline that checkpoints after every stage and resumes without redoing completed work.",
    difficulty: "Intermediate",
    time: "~5 min",
    icon: Database,
  },
  {
    slug: "ai-agent-bugfix",
    title: "AI Agent Bugfix",
    description:
      "An agent that debugs and fixes a failing test on its own, then gets independently verified.",
    difficulty: "Intermediate",
    time: "~10 min",
    icon: Bug,
  },
  {
    slug: "persistent-agent-memory",
    title: "Persistent Agent Memory",
    description:
      "An agent that remembers things about a customer across sandbox sessions, via @alineo-labs/memory.",
    difficulty: "Advanced",
    time: "~10 min",
    icon: Brain,
  },
  {
    slug: "credential-scoped-agent",
    title: "Credential-Scoped Agent",
    description:
      "An agent that calls an authenticated API with a token it can never read — injected at the egress layer.",
    difficulty: "Advanced",
    time: "~10 min",
    icon: KeyRound,
  },
];
