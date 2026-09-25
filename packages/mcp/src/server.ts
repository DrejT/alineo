/**
 * Builds the MCP server: registers every tool once against a fresh `AlineodClient` +
 * `McpServer` pair. Kept separate from `index.ts` (which owns the stdio transport) so tests can
 * connect a server instance to an in-memory transport without spawning a process.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { AlineodClient, AlineodError } from "./alineod-client.js";
import { init } from "./init.js";
import { addSpec, listSpecs, removeSpec } from "./specs.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(err: unknown): ToolResult {
  const message =
    err instanceof AlineodError
      ? `alineod error (${err.status || "network"}): ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wraps a tool handler so a thrown error becomes an `isError` result, never an uncaught rejection. */
function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

const BudgetOverride = z
  .object({
    spawnDepth: z.number().int().nonnegative().optional(),
    maxAgents: z.number().int().nonnegative().optional(),
  })
  .describe("Overrides the spec's own spawnDepth / maxAgents (flag-beats-config).");

const AgentSpecInput = z
  .record(z.string(), z.unknown())
  .describe("An alineo AgentSpec object (validated server-side by alineod's own SDK call).");

export function buildServer(
  clientOpts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): McpServer {
  const client = new AlineodClient(clientOpts);

  const server = new McpServer(
    { name: "alineo-mcp", version: pkg.version },
    {
      instructions:
        "Orchestrate swarms of sandboxed coding agents via alineod, alineo's HTTP+SSE control " +
        "daemon, plus local agent-spec management. Typical flow: init (once, to start " +
        "OpenSandbox + alineod locally) → spec_add / spec_list to get an " +
        "AgentSpec → run_start to start a swarm → agent_spawn to fan out " +
        "children → agent_prompt / agent_steer to drive them → " +
        "run_watch or run_get to observe progress → result_get to " +
        "read a settled agent's output → agent_stop / run_stop to tear down. " +
        "alineod must be reachable (default http://127.0.0.1:4600, override with ALINEOD_URL) " +
        "for every run_*, agent_* and result_* tool; init starts it.",
    },
  );

  // ── alineod: swarm control (primary) ──────────────────────────────────────

  server.registerTool(
    "run_start",
    {
      title: "Create a swarm run",
      description:
        "POST /runs — load the root agent from an AgentSpec, optionally drive one prompt on " +
        'it. Returns immediately with state "provisioning"; poll run_get for the ' +
        "real state.",
      inputSchema: z.object({
        spec: AgentSpecInput,
        prompt: z
          .string()
          .optional()
          .describe("If set, drive one turn on the root agent after load."),
        budget: BudgetOverride.optional(),
      }),
    },
    safe(async ({ spec, prompt, budget }) => ok(await client.createRun({ spec, prompt, budget }))),
  );

  server.registerTool(
    "run_get",
    {
      title: "Get a run's spawn tree",
      description:
        "GET /runs/:runId — the flat list of every agent in the run, with parent pointers and current state.",
      inputSchema: z.object({ runId: z.string().min(1) }),
    },
    safe(async ({ runId }) => ok(await client.getRun(runId))),
  );

  server.registerTool(
    "run_stop",
    {
      title: "Tear down a run",
      description:
        "DELETE /runs/:runId — abort and close every live agent in the run. The ledger is kept.",
      inputSchema: z.object({ runId: z.string().min(1) }),
    },
    safe(async ({ runId }) => {
      await client.deleteRun(runId);
      return ok(`Run ${runId} torn down (every live agent aborted and closed).`);
    }),
  );

  server.registerTool(
    "run_watch",
    {
      title: "Watch a run's live events",
      description:
        "GET /runs/:runId/events (SSE) — collects lifecycle events (agent.spawned, " +
        "agent.state_changed, agent.ended, handle.settled, budget.denied, …) and forwarded " +
        "harness events (message.updated, tool.started, tool.ended, …) for a bounded window, " +
        "since this is a " +
        "request/response tool call rather than a live stream. Pass sinceEventId (the last " +
        "event's `id`) to resume from where you left off without missing anything persisted.",
      inputSchema: z.object({
        runId: z.string().min(1),
        sinceEventId: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Resume after this ledger seq (Last-Event-ID)."),
        maxWaitSeconds: z
          .number()
          .int()
          .min(1)
          .max(120)
          .optional()
          .describe("Default 20, capped at 120."),
        maxEvents: z.number().int().min(1).max(500).optional().describe("Default 50."),
      }),
    },
    safe(async ({ runId, sinceEventId, maxWaitSeconds, maxEvents }) =>
      ok(
        await client.watchEvents(runId, {
          sinceEventId,
          maxWaitMs: maxWaitSeconds !== undefined ? maxWaitSeconds * 1000 : undefined,
          maxEvents,
        }),
      ),
    ),
  );

  // ── alineod: agent control ────────────────────────────────────────────────

  server.registerTool(
    "agent_spawn",
    {
      title: "Spawn a child agent",
      description:
        "POST /runs/:runId/agents — fork a new child under a live parent. Set waitFor to hold " +
        "the spawn until other agents' results settle (their output is written into the " +
        "child's sandbox before it starts).",
      inputSchema: z.object({
        runId: z.string().min(1),
        spec: AgentSpecInput,
        parentAgentId: z.string().min(1),
        waitFor: z
          .array(z.string())
          .optional()
          .describe("Agent IDs whose handles must settle before this spawn proceeds."),
        prompt: z.string().optional(),
        budget: BudgetOverride.optional(),
        idempotencyKey: z
          .string()
          .optional()
          .describe("A retried call with the same key returns the original spawn."),
      }),
    },
    safe(async ({ runId, spec, parentAgentId, waitFor, prompt, budget, idempotencyKey }) =>
      ok(
        await client.spawnAgent(runId, {
          spec,
          parentAgentId,
          waitFor,
          prompt,
          budget,
          idempotencyKey,
        }),
      ),
    ),
  );

  server.registerTool(
    "agent_get",
    {
      title: "Inspect an agent",
      description:
        "GET /agents/:agentId — the agent's current view plus session stats (token usage, cost, message counts) when live and not paused.",
      inputSchema: z.object({ agentId: z.string().min(1) }),
    },
    safe(async ({ agentId }) => ok(await client.getAgent(agentId))),
  );

  server.registerTool(
    "agent_prompt",
    {
      title: "Prompt an agent",
      description:
        "POST /agents/:agentId/prompt — drive one turn. Returns immediately (202); poll result_get or run_watch for the reply.",
      inputSchema: z.object({ agentId: z.string().min(1), text: z.string().min(1) }),
    },
    safe(async ({ agentId, text }) => {
      await client.promptAgent(agentId, text);
      return ok(`Prompt accepted for agent ${agentId}.`);
    }),
  );

  server.registerTool(
    "agent_steer",
    {
      title: "Steer an agent's current turn",
      description:
        "POST /agents/:agentId/steer — inject a message into the agent's in-flight turn (lands at the next turn boundary). The named agent only, never a subtree.",
      inputSchema: z.object({ agentId: z.string().min(1), message: z.string().min(1) }),
    },
    safe(async ({ agentId, message }) => {
      await client.steerAgent(agentId, message);
      return ok(`Steer message accepted for agent ${agentId}.`);
    }),
  );

  server.registerTool(
    "agent_pause",
    {
      title: "Pause an agent",
      description: "POST /agents/:agentId/pause — freeze the agent's sandbox container.",
      inputSchema: z.object({ agentId: z.string().min(1) }),
    },
    safe(async ({ agentId }) => {
      await client.pauseAgent(agentId);
      return ok(`Agent ${agentId} pausing.`);
    }),
  );

  server.registerTool(
    "agent_resume",
    {
      title: "Resume a paused agent",
      description: "POST /agents/:agentId/resume — thaw a paused sandbox container.",
      inputSchema: z.object({ agentId: z.string().min(1) }),
    },
    safe(async ({ agentId }) => {
      await client.resumeAgent(agentId);
      return ok(`Agent ${agentId} resuming.`);
    }),
  );

  server.registerTool(
    "agent_stop",
    {
      title: "Stop an agent",
      description:
        'POST /agents/:agentId/stop — abort and close one agent. mode defaults to "abort" ("drain" currently behaves the same).',
      inputSchema: z.object({
        agentId: z.string().min(1),
        mode: z.enum(["abort", "drain"]).optional(),
      }),
    },
    safe(async ({ agentId, mode }) => {
      await client.stopAgent(agentId, mode);
      return ok(`Agent ${agentId} stopping (mode: ${mode ?? "abort"}).`);
    }),
  );

  server.registerTool(
    "result_get",
    {
      title: "Get an agent's result",
      description:
        "GET /agents/:agentId/result — resolve a settled agent's output. Pass waitSeconds to " +
        "long-poll (server-held) until it settles or the timeout elapses, instead of polling " +
        "yourself.",
      inputSchema: z.object({
        agentId: z.string().min(1),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(240)
          .optional()
          .describe("Server-side long-poll bound, capped at 240."),
      }),
    },
    safe(async ({ agentId, waitSeconds }) => ok(await client.getResult(agentId, waitSeconds))),
  );

  // ── alineo: local spec management + bootstrap ─────────────────────────────

  server.registerTool(
    "init",
    {
      title: "Start OpenSandbox + alineod locally",
      description:
        "Starts OpenSandbox and alineod in Docker (pulling images if needed) and writes " +
        "alineo.config.json in the current directory if missing. Run this once before any " +
        "run_*, agent_* or result_* tool if alineod isn't already running. Requires Docker.",
      inputSchema: z.object({}),
    },
    safe(async () => ok(await init())),
  );

  server.registerTool(
    "spec_add",
    {
      title: "Add an agent spec",
      description:
        "Fetches an AgentSpec from a URL or local file path, validates it, and saves it to the " +
        "local agent-spec cache (recursively resolving registryDependencies). The saved spec's " +
        "object is what run_start / agent_spawn expect as `spec`.",
      inputSchema: z.object({
        url: z
          .string()
          .min(1)
          .describe("An https:// URL or a local file path to an AgentSpec JSON file."),
        name: z
          .string()
          .optional()
          .describe("Override the spec's own name for the saved filename."),
      }),
    },
    safe(async ({ url, name }) => ok(await addSpec(url, name))),
  );

  server.registerTool(
    "spec_list",
    {
      title: "List saved agent specs",
      description: "Lists every AgentSpec saved locally via spec_add.",
      inputSchema: z.object({}),
    },
    safe(async () => ok(await listSpecs())),
  );

  server.registerTool(
    "spec_remove",
    {
      title: "Remove a saved agent spec",
      description: "Deletes a locally saved AgentSpec by name.",
      inputSchema: z.object({ name: z.string().min(1) }),
    },
    safe(async ({ name }) => {
      await removeSpec(name);
      return ok(`Removed agent spec '${name}'.`);
    }),
  );

  return server;
}
