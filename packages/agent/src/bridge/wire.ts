/**
 * The wire contract between the host (`adapters/pi.ts`) and the in-sandbox bridge
 * (`bridge/pi-bridge.ts`), plus the slice of Pi's RPC the bridge reads.
 *
 * Types only. This module must stay free of runtime imports: the bridge is bundled into one
 * file that runs in the sandbox, outside any package.
 */

/** A decision on one held permission request. Mirrors `PermissionDecision` in `permissions.ts`. */
export type BridgePermissionDecision =
  | { kind: "once" }
  | { kind: "always" }
  | { kind: "reject"; feedback?: string };

/** What the bridge sends down `/permission-stream` and into an open prompt stream. */
export type BridgePermissionEvent =
  | { type: "permission_request"; requestId: string; tool: string; target: string; title: string }
  | { type: "permission_resolved"; requestId: string; decision: BridgePermissionDecision };

/** JSON bodies the host POSTs to the bridge. Every field is optional: the bridge defaults them. */
export interface BridgeRequestBody {
  message?: string;
  streamingBehavior?: "steer" | "followUp";
  command?: string;
  entryId?: string;
  sessionPath?: string;
  provider?: string;
  modelId?: string;
  level?: string;
  customInstructions?: string;
  enabled?: boolean;
  name?: string;
  mode?: string;
  outputPath?: string;
  env?: Record<string, string>;
  requestId?: string;
  decision?: { kind?: string; feedback?: string };
}

/** One line of Pi's stdout in `--mode rpc`. Pi's schema is open, so unknown keys stay `unknown`. */
export interface PiLine {
  type?: string;
  id?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: { model?: { id?: string; api?: string }; output?: string } | null;
  method?: string;
  title?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
  finalError?: unknown;
  turnIndex?: number;
  timestamp?: number;
  message?: unknown;
  toolResults?: unknown[];
  steering?: unknown[];
  followUp?: unknown[];
  reason?: unknown;
  aborted?: boolean;
  willRetry?: boolean;
  extensionPath?: string;
  event?: string;
  messages?: unknown[];
  assistantMessageEvent?: { type?: string; delta?: string } | null;
  [key: string]: unknown;
}

/** The permission policy the gate reads from `/etc/alineo-pi.json`. Mirrors `permissions.ts`. */
export type GateAction = "allow" | "deny" | "ask" | "classify" | "rate_limit";

export interface GateRule {
  tool: string;
  pattern?: string | null;
  action: GateAction;
  limit?: { count: number; windowMs: number };
}

export interface GatePolicy {
  default: GateAction;
  rules: GateRule[];
  disabledTools: string[];
  restrictToTools: string[];
}
