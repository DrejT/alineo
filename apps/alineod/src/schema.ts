/**
 * The wire contract, as Zod. One source of truth → route validators AND the emitted
 * `specs/alineod/openapi.json` + `events.schema.json` (research/daemon.md §2, §7).
 *
 * `AgentSpec` itself is validated by the SDK's own `validateAgentSpec()` inside `Alineo.load()`
 * / `.spawn()`, so here it's an opaque object — alineod does not re-model it.
 */
import { z } from "zod";

/** Opaque pass-through: the SDK owns `AgentSpec` validation. */
export const AgentSpec = z.record(z.string(), z.unknown()).describe("alineo AgentSpec (validated by the SDK)");

export const BudgetOverride = z
  .object({
    spawnDepth: z.number().int().nonnegative().optional(),
    maxAgents: z.number().int().nonnegative().optional(),
  })
  .describe("Overrides the spec's own spawnDepth / maxAgents (flag-beats-config).");

// ── POST /runs ────────────────────────────────────────────────────────────────

export const CreateRunBody = z.object({
  spec: AgentSpec,
  prompt: z.string().optional().describe("If set, drive one turn on the root agent after load."),
  budget: BudgetOverride.optional(),
});
export type CreateRunBody = z.infer<typeof CreateRunBody>;

export const CreateRunResponse = z.object({
  runId: z.string(),
  rootAgentId: z.string(),
});

// ── POST /runs/:runId/agents ──────────────────────────────────────────────────

export const SpawnAgentBody = z.object({
  spec: AgentSpec,
  parentAgentId: z.string(),
  waitFor: z
    .array(z.string())
    .optional()
    .describe("Hold the spawn until every named agent's handle is settled (hold-then-spawn, D-c)."),
  prompt: z.string().optional(),
  budget: BudgetOverride.optional(),
});
export type SpawnAgentBody = z.infer<typeof SpawnAgentBody>;

export const SpawnAgentResponse = z.object({ agentId: z.string() });

// ── agent / tree views ───────────────────────────────────────────────────────

export const AgentView = z.object({
  agentId: z.string(),
  runId: z.string(),
  parentAgentId: z.string().nullable(),
  depth: z.number().int(),
  spawnIndex: z.number().int(),
  state: z.string(),
  specName: z.string(),
  sandboxId: z.string().nullable(),
  createdAt: z.number(),
  endedAt: z.number().nullable(),
  outcome: z.string().nullable(),
});
export type AgentView = z.infer<typeof AgentView>;

export const TreeView = z.object({
  runId: z.string(),
  rootAgentId: z.string().nullable(),
  agents: z.array(AgentView),
  asOf: z.number().describe("Highest ledger seq reflected in this projection."),
});

export const AgentDetail = AgentView.extend({
  sessionStats: z.unknown().optional(),
});

// ── POST /agents/:id/stop ────────────────────────────────────────────────────

export const StopAgentBody = z
  .object({ mode: z.enum(["abort", "drain"]).default("abort") })
  .default({ mode: "abort" });

// ── POST /agents/:id/prompt ──────────────────────────────────────────────────

export const PromptBody = z.object({ text: z.string().min(1) });

// ── GET /agents/:id/result ───────────────────────────────────────────────────

export const ResultResponse = z.object({
  agentId: z.string(),
  state: z.enum(["pending", "settled"]),
  outcome: z.string().nullable(),
  resultRef: z.string().nullable(),
  result: z.string().nullable().describe("Prototype convenience: the inline result text."),
});

// ── the event union (research/daemon.md §7) ──────────────────────────────────
//
// alineod's own agent-lifecycle events. Forwarded harness events (`text`, `tool_start`, …)
// ride the same SSE stream tagged with `agentId` but are modelled by the SDK, not here.

const EventBase = z.object({ agentId: z.string().nullable() });

export const AlineodEvent = z.discriminatedUnion("event", [
  z.object({ event: z.literal("run_started"), runId: z.string() }),
  EventBase.extend({
    event: z.literal("agent_spawned"),
    parentAgentId: z.string().nullable(),
    runId: z.string(),
    specName: z.string(),
    depth: z.number().int(),
    spawnIndex: z.number().int(),
    sandboxId: z.string().nullable(),
  }),
  EventBase.extend({
    event: z.literal("agent_state_changed"),
    from: z.string(),
    to: z.string(),
    reason: z.string().optional(),
  }),
  EventBase.extend({
    event: z.literal("agent_ended"),
    outcome: z.string(),
    endedAt: z.number(),
    error: z.string().optional(),
  }),
  EventBase.extend({
    event: z.literal("handle_settled"),
    outcome: z.string(),
    resultRef: z.string().nullable(),
  }),
  EventBase.extend({
    event: z.literal("budget_denied"),
    dimension: z.enum(["spawnDepth", "maxAgents"]),
    remaining: z.number().int(),
  }),
]);
export type AlineodEvent = z.infer<typeof AlineodEvent>;
