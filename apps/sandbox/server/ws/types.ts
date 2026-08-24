// Imported from @alineo-labs/core rather than `alineo` — the `alineo` package's built dist currently
// drops this type-only re-export (a bundling gap in packages/sdks/typescript, not something
// this app should work around by duplicating the type).
import type { InteractiveExecHandle } from "@alineo-labs/core";

export type WSData =
  | {
      kind: "terminal";
      /** Which registry map `id` is looked up in — plain sandboxes vs. an agent's `.sandbox`. */
      source: "sandbox" | "agent";
      id: string;
      handle: InteractiveExecHandle | null;
    }
  | { kind: "metrics"; sandboxId: string; stop: (() => void) | null }
  | { kind: "chat"; agentId: string; streaming: boolean };
