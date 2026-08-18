import type { Metadata } from "next";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Common questions about alineo, OpenSandbox, and getting set up.",
};

export default function FaqPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-[-0.025em] text-fd-foreground">FAQ</h1>
      <Accordions type="single">
        <Accordion title="What is OpenSandbox, and do I need Docker?">
          alineo runs sandboxes against an <a href="https://open-sandbox.ai">OpenSandbox</a>{" "}
          instance — it's the container runtime underneath. The fastest way to get one locally is{" "}
          <code>bunx alineo-cli init</code>, which starts OpenSandbox in Docker and configures
          alineo to talk to it automatically. If you'd rather not use Docker, you can run{" "}
          <code>uvx opensandbox-server</code> directly on your host instead — see the{" "}
          <a href="/docs/alineo/getting-started">alineo CLI docs</a> for both paths.
        </Accordion>
        <Accordion title="SQLite or Postgres — which storage adapter should I use?">
          SQLite (<code>@alineo-labs/sqlite</code>) is the right default for local development and
          single-process deployments — zero config, WAL mode, nothing to run. Postgres (
          <code>@alineo-labs/postgres</code>) is for production, multi-process deployments that need
          a shared ledger across instances. Both implement the same <code>IStorageAdapter</code>{" "}
          interface, so switching later is a one-line change — see{" "}
          <a href="/docs/core/adapters">Storage Adapters</a>.
        </Accordion>
        <Accordion title="What's the difference between alineo, @alineo-labs/workflow, and @alineo-labs/agent?">
          <code>alineo</code> is the core SDK — the <code>Alineo</code> client and the{" "}
          <code>Sandbox</code> object itself (spawn, exec, checkpoint, resume).{" "}
          <code>@alineo-labs/workflow</code> adds a lazy pipeline builder on top — retry, branching,
          and fan-out across multiple sandboxes. <code>@alineo-labs/agent</code> runs Pi coding
          agents inside a sandbox container. You only need <code>workflow</code> or{" "}
          <code>agent</code> if you're using their specific features — plain sandbox usage only
          needs the core <code>alineo</code> package.
        </Accordion>
        <Accordion title="Does alineo work on Windows?">
          Yes — the repo has native cross-platform support and can be developed directly on Windows
          without WSL or Git Bash. Repository scripts use Bun's native shell APIs, and{" "}
          <code>alineo init</code> detects Windows and uses named pipes (
          <code>//./pipe/docker_engine</code>) for Docker socket injection automatically.
        </Accordion>
        <Accordion title="Is alineo open source?">
          Yes — Apache 2.0, and published to npm as <code>alineo</code>. The source is at{" "}
          <a href="https://github.com/DrejT/alineo">github.com/DrejT/alineo</a>.
        </Accordion>
      </Accordions>
    </div>
  );
}
