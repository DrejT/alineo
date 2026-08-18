import type { Metadata } from "next";
import { Card, Cards } from "fumadocs-ui/components/card";

export const metadata: Metadata = {
  title: "Cookbook",
  description: "Task-oriented recipes for building with alineo.",
};

export default function CookbookPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-[-0.025em] text-fd-foreground">Cookbook</h1>
      <p className="text-fd-muted-foreground">
        Recipes for handling failure, time, and observability in the Core SDK. Workflow, Agent, and
        CLI recipes are on the way.
      </p>
      <Cards>
        <Card
          href="/docs/core/patterns/timeouts-and-cancellation"
          title="Timeouts & cancellation"
          description="Sandbox lifetime, bash timeout command, and try/finally cleanup."
        />
        <Card
          href="/docs/core/patterns/error-handling"
          title="Error handling"
          description="Strict vs non-strict exec, CommandError, SandboxError, and ExecConnectionError."
        />
        <Card
          href="/docs/core/patterns/run-management"
          title="Run management"
          description="List, resume, and delete runs from the ledger."
        />
        <Card
          href="/docs/core/patterns/named-checkpoints"
          title="Named checkpoints"
          description="Save and restore sandbox state under a name you choose."
        />
        <Card
          href="/docs/core/patterns/fork"
          title="Forking sandboxes"
          description="Branch a sandbox into independent copies without repeating setup."
        />
        <Card
          href="/docs/core/patterns/observability"
          title="Observability"
          description="WorkflowHooks and OpenTelemetry tracing with @alineo-labs/otel."
        />
        <Card
          href="/docs/core/patterns/flue"
          title="Flue integration"
          description="Use alineo sandboxes as Flue session environments with @alineo-labs/flue."
        />
      </Cards>
    </div>
  );
}
