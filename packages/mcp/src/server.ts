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
      ? `alineod error (${err.status || "network"}${err.code ? `, ${err.code}` : ""}): ${err.message}` +
        (err.hint ? `\nHint: ${err.hint}` : "")
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

const CloseWhen = z
  .enum(["explicit", "quiescent"])
  .describe(
    '"explicit" (default): the run stays open until run_stop deletes it. "quiescent": the ' +
      "run closes itself the moment every agent in it is done.",
  );

const Scope = z
  .enum(["agent", "subtree"])
  .describe('"agent" (default): the named agent only. "subtree": it and every descendant.');

const AgentSpecInput =z
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
        "run_watch or run_get to observe progress, or agent_await / run_await to block until " +
        "agents settle → result_get to read a settled agent's output (transcript_get for the " +
        "full conversation) → agent_stop / run_stop to tear down. Agents can message each " +
        "other via notify_add / inbox_list / inbox_deliver, and carry state in memory_* and " +
        "fact_* tools. " +
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
        closeWhen: CloseWhen.optional(),
      }),
    },
    safe(async ({ spec, prompt, budget, closeWhen }) =>
      ok(await client.createRun({ spec, prompt, budget, closeWhen })),
    ),
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
      inputSchema: z.object({
        agentId: z.string().min(1),
        message: z.string().min(1),
        scope: Scope.optional(),
      }),
    },
    safe(async ({ agentId, message, scope }) => {
      const res = await client.steerAgent(agentId, message, scope);
      return res === undefined ? ok(`Steer message accepted for agent ${agentId}.`) : ok(res);
    }),
  );

  server.registerTool(
    "agent_pause",
    {
      title: "Pause an agent",
      description:
        "POST /agents/:agentId/pause — freeze the agent's sandbox container. " +
        'scope "subtree" pauses it and every descendant, parents first.',
      inputSchema: z.object({ agentId: z.string().min(1), scope: Scope.optional() }),
    },
    safe(async ({ agentId, scope }) => {
      const res = await client.pauseAgent(agentId, scope);
      return res === undefined ? ok(`Agent ${agentId} pausing.`) : ok(res);
    }),
  );

  server.registerTool(
    "agent_resume",
    {
      title: "Resume a paused agent",
      description:
        "POST /agents/:agentId/resume — thaw a paused sandbox container. " +
        'scope "subtree" resumes it and every descendant, children first.',
      inputSchema: z.object({ agentId: z.string().min(1), scope: Scope.optional() }),
    },
    safe(async ({ agentId, scope }) => {
      const res = await client.resumeAgent(agentId, scope);
      return res === undefined ? ok(`Agent ${agentId} resuming.`) : ok(res);
    }),
  );

  server.registerTool(
    "agent_stop",
    {
      title: "Stop an agent",
      description:
        'POST /agents/:agentId/stop — abort and close one agent. mode defaults to "abort" ("drain" currently behaves the same). ' +
        'scope "subtree" stops it and every descendant, leaves first, with one result per member.',
      inputSchema: z.object({
        agentId: z.string().min(1),
        mode: z.enum(["abort", "drain"]).optional(),
        scope: Scope.optional(),
      }),
    },
    safe(async ({ agentId, mode, scope }) => {
      const res = await client.stopAgent(agentId, mode, scope);
      return res === undefined ? ok(`Agent ${agentId} stopping (mode: ${mode ?? "abort"}).`) : ok(res);
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

  // ── alineod: waits ────────────────────────────────────────────────────────

  server.registerTool(
    "agent_await",
    {
      title: "Wait for an agent's subtree to settle",
      description:
        "GET /agents/:agentId/await?scope=subtree — server-held long-poll until the agent and " +
        "every descendant are quiescent, or waitSeconds elapses. Use instead of polling " +
        "run_get. Returns each member's outcome and whether the subtree is quiescent.",
      inputSchema: z.object({
        agentId: z.string().min(1),
        waitSeconds: z.number().int().min(0).max(240).optional().describe("Capped at 240."),
      }),
    },
    safe(async ({ agentId, waitSeconds }) => ok(await client.awaitAgent(agentId, waitSeconds))),
  );

  server.registerTool(
    "run_await",
    {
      title: "Wait on a set of agents in a run",
      description:
        "POST /runs/:runId/await — hold until a wait regime over `agents` is met, or until " +
        "`subtree`'s agent is quiescent (give exactly one of the two). mode: settled (every " +
        "agent terminal), all (every one succeeded), any (the first to settle), quorum (k " +
        "successes). outcome is satisfied, partial, depfail or pending (timed out).",
      inputSchema: z.object({
        runId: z.string().min(1),
        agents: z.array(z.string().min(1)).min(1).optional(),
        subtree: z.string().min(1).optional(),
        mode: z.enum(["settled", "all", "any", "quorum"]).optional(),
        k: z.number().int().positive().optional().describe('Required when mode is "quorum".'),
        onDepFailure: z.enum(["fail", "proceed"]).optional(),
        waitSeconds: z.number().min(0).max(240).optional().describe("Capped at 240."),
      }),
    },
    safe(async ({ runId, waitSeconds, ...rest }) =>
      ok(await client.awaitRun(runId, { ...rest, wait: waitSeconds })),
    ),
  );

  // ── alineod: records a run leaves behind ──────────────────────────────────

  server.registerTool(
    "transcript_get",
    {
      title: "Read an agent's transcript",
      description:
        "GET /agents/:agentId/transcript — the agent's conversation: user messages, assistant " +
        "text with tool calls, and tool results. Pass full to include the model's thinking.",
      inputSchema: z.object({ agentId: z.string().min(1), full: z.boolean().optional() }),
    },
    safe(async ({ agentId, full }) => ok(await client.getTranscript(agentId, full))),
  );

  // ── alineod: agent-to-agent messaging ─────────────────────────────────────

  server.registerTool(
    "notify_add",
    {
      title: "Subscribe an agent to others' results",
      description:
        "POST /agents/:agentId/notify-on — when any of `agents` settles, a notification lands " +
        "in this agent's inbox. With wake, an idle subscriber starts a turn with it instead of " +
        "queueing it.",
      inputSchema: z.object({
        agentId: z.string().min(1).describe("The subscriber."),
        agents: z.array(z.string().min(1)).min(1).describe("The agents to be told about."),
        wake: z.boolean().optional(),
      }),
    },
    safe(async ({ agentId, agents, wake }) => ok(await client.notifyOn(agentId, { agents, wake }))),
  );

  server.registerTool(
    "inbox_list",
    {
      title: "List an agent's inbox",
      description:
        "GET /agents/:agentId/inbox — notifications waiting for the agent (`pending`) and ones " +
        "already handed over (`delivered`).",
      inputSchema: z.object({ agentId: z.string().min(1) }),
    },
    safe(async ({ agentId }) => ok(await client.getInbox(agentId))),
  );

  server.registerTool(
    "inbox_deliver",
    {
      title: "Deliver an agent's pending inbox",
      description:
        "POST /agents/:agentId/inbox/deliver — hand every pending notification to the agent now, " +
        "waking it with a turn if it is idle. The response says how it was delivered " +
        "(steer / turn / queued).",
      inputSchema: z.object({ agentId: z.string().min(1) }),
    },
    safe(async ({ agentId }) => ok(await client.deliverInbox(agentId))),
  );

  // ── alineod: agent memory ─────────────────────────────────────────────────

  server.registerTool(
    "memory_list",
    {
      title: "List an agent's working memory",
      description:
        "GET /agents/:agentId/memory — key/value working memory in key order, paged. Pass the " +
        "response's `nextAfter` as `after` for the next page.",
      inputSchema: z.object({
        agentId: z.string().min(1),
        limit: z.number().int().min(1).optional(),
        after: z.string().optional().describe("Return keys after this one."),
      }),
    },
    safe(async ({ agentId, limit, after }) => ok(await client.listMemory(agentId, { limit, after }))),
  );

  server.registerTool(
    "memory_get",
    {
      title: "Read one working-memory key",
      description: "GET /agents/:agentId/memory/:key — 404 if the key is not set.",
      inputSchema: z.object({ agentId: z.string().min(1), key: z.string().min(1) }),
    },
    safe(async ({ agentId, key }) => ok(await client.getMemory(agentId, key))),
  );

  server.registerTool(
    "memory_set",
    {
      title: "Write one working-memory key",
      description:
        "PUT /agents/:agentId/memory/:key — create or overwrite. The value is any JSON " +
        "(size-capped by alineod); use it to seed an agent with state before it runs.",
      inputSchema: z.object({
        agentId: z.string().min(1),
        key: z.string().min(1),
        value: z.unknown().describe("Any JSON-serializable value."),
      }),
    },
    safe(async ({ agentId, key, value }) => ok(await client.setMemory(agentId, key, value))),
  );

  server.registerTool(
    "memory_remove",
    {
      title: "Delete one working-memory key",
      description: "DELETE /agents/:agentId/memory/:key.",
      inputSchema: z.object({ agentId: z.string().min(1), key: z.string().min(1) }),
    },
    safe(async ({ agentId, key }) => {
      await client.deleteMemory(agentId, key);
      return ok(`Memory key '${key}' removed for agent ${agentId}.`);
    }),
  );

  server.registerTool(
    "fact_add",
    {
      title: "Remember a fact",
      description:
        "POST /agents/:agentId/facts — store one item of the agent's semantic memory. A fact " +
        "with a sourceRef (the sandbox and ledger entry it came from) is marked verified. " +
        "Needs semantic memory enabled on alineod.",
      inputSchema: z.object({
        agentId: z.string().min(1),
        content: z.string().min(1),
        sourceRef: z
          .object({
            sandboxId: z.string().min(1),
            entryIndex: z.number().int().nonnegative(),
          })
          .optional(),
      }),
    },
    safe(async ({ agentId, content, sourceRef }) =>
      ok(await client.addFact(agentId, { content, sourceRef })),
    ),
  );

  server.registerTool(
    "fact_list",
    {
      title: "Recall or list facts",
      description:
        "GET /agents/:agentId/facts — with `query`, the topK facts most similar to it; without, " +
        "the newest `limit` facts.",
      inputSchema: z.object({
        agentId: z.string().min(1),
        query: z.string().optional(),
        topK: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).optional(),
      }),
    },
    safe(async ({ agentId, query, topK, limit }) =>
      ok(await client.listFacts(agentId, { query, topK, limit })),
    ),
  );

  server.registerTool(
    "compaction_start",
    {
      title: "Compact an agent's semantic memory",
      description:
        "POST /agents/:agentId/compactions — drop facts beyond maxFacts (oldest first) or older " +
        "than maxAgeMs. Both are optional and combinable; with neither, nothing is removed. " +
        "Returns how many were removed and remain.",
      inputSchema: z.object({
        agentId: z.string().min(1),
        maxFacts: z.number().int().positive().optional(),
        maxAgeMs: z.number().int().positive().optional(),
      }),
    },
    safe(async ({ agentId, maxFacts, maxAgeMs }) =>
      ok(await client.compactMemory(agentId, { maxFacts, maxAgeMs })),
    ),
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
