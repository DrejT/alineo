import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Common questions about alineo, OpenSandbox, and getting set up.",
  alternates: { canonical: "https://docs.alineo.tech/faq" },
};

interface Faq {
  question: string;
  /** Rendered answer (may contain links / code). */
  answer: ReactNode;
  /** Plain-text answer for the FAQPage structured data. */
  text: string;
}

const FAQS: Faq[] = [
  {
    question: "What is OpenSandbox, and do I need Docker?",
    answer: (
      <>
        alineo runs sandboxes against an <a href="https://open-sandbox.ai">OpenSandbox</a> instance
        — it&apos;s the container runtime underneath. The fastest way to get one locally is{" "}
        <code>bunx alineo-cli init</code>, which starts OpenSandbox in Docker and configures alineo
        to talk to it automatically. If you&apos;d rather not use Docker, you can run{" "}
        <code>uvx opensandbox-server</code> directly on your host instead — see the{" "}
        <a href="/docs/alineo/getting-started">alineo CLI docs</a> for both paths.
      </>
    ),
    text: "alineo runs sandboxes against an OpenSandbox instance — the container runtime underneath. The fastest way to get one locally is `bunx alineo-cli init`, which starts OpenSandbox in Docker and configures alineo automatically. If you'd rather not use Docker, run `uvx opensandbox-server` directly on your host instead.",
  },
  {
    question: "SQLite or Postgres — which storage adapter should I use?",
    answer: (
      <>
        SQLite (<code>@alineo-labs/sqlite</code>) is the right default for local development and
        single-process deployments — zero config, WAL mode, nothing to run. Postgres (
        <code>@alineo-labs/postgres</code>) is for production, multi-process deployments that need a
        shared ledger across instances. Both implement the same <code>IStorageAdapter</code>{" "}
        interface, so switching later is a one-line change — see{" "}
        <a href="/docs/core/adapters">Storage Adapters</a>.
      </>
    ),
    text: "SQLite (@alineo-labs/sqlite) is the right default for local development and single-process deployments — zero config, WAL mode, nothing to run. Postgres (@alineo-labs/postgres) is for production, multi-process deployments that need a shared ledger across instances. Both implement the same IStorageAdapter interface, so switching later is a one-line change.",
  },
  {
    question:
      "What's the difference between alineo, @alineo-labs/workflow, and @alineo-labs/agent?",
    answer: (
      <>
        <code>alineo</code> is the core SDK — the <code>Alineo</code> client and the{" "}
        <code>Sandbox</code> object itself (spawn, exec, checkpoint, resume).{" "}
        <code>@alineo-labs/workflow</code> adds a lazy pipeline builder on top — retry, branching,
        and fan-out across multiple sandboxes. <code>@alineo-labs/agent</code> runs Pi coding agents
        inside a sandbox container. You only need <code>workflow</code> or <code>agent</code> if
        you&apos;re using their specific features — plain sandbox usage only needs the core{" "}
        <code>alineo</code> package.
      </>
    ),
    text: "`alineo` is the core SDK — the Alineo client and the Sandbox object itself (spawn, exec, checkpoint, resume). `@alineo-labs/workflow` adds a lazy pipeline builder on top — retry, branching, and fan-out across multiple sandboxes. `@alineo-labs/agent` runs Pi coding agents inside a sandbox container. You only need workflow or agent if you're using their specific features.",
  },
  {
    question: "Does alineo work on Windows?",
    answer: (
      <>
        Yes — the repo has native cross-platform support and can be developed directly on Windows
        without WSL or Git Bash. Repository scripts use Bun&apos;s native shell APIs, and{" "}
        <code>alineo init</code> detects Windows and uses named pipes (
        <code>//./pipe/docker_engine</code>) for Docker socket injection automatically.
      </>
    ),
    text: "Yes — the repo has native cross-platform support and can be developed directly on Windows without WSL or Git Bash. Repository scripts use Bun's native shell APIs, and `alineo init` detects Windows and uses named pipes (//./pipe/docker_engine) for Docker socket injection automatically.",
  },
  {
    question: "Is alineo open source?",
    answer: (
      <>
        Yes — Apache 2.0, and published to npm as <code>alineo</code>. The source is at{" "}
        <a href="https://github.com/DrejT/alineo">github.com/DrejT/alineo</a>.
      </>
    ),
    text: "Yes — Apache 2.0, and published to npm as `alineo`. The source is at github.com/DrejT/alineo.",
  },
];

const faqStructuredData = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQS.map((faq) => ({
    "@type": "Question",
    name: faq.question,
    acceptedAnswer: { "@type": "Answer", text: faq.text },
  })),
};

export default function FaqPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqStructuredData) }}
      />
      <h1 className="text-3xl font-semibold tracking-[-0.025em] text-fd-foreground">FAQ</h1>
      <Accordions type="single">
        {FAQS.map((faq) => (
          <Accordion key={faq.question} title={faq.question}>
            {faq.answer}
          </Accordion>
        ))}
      </Accordions>
    </div>
  );
}
