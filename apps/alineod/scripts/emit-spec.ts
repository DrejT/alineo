/**
 * Emit the language-neutral protocol artifacts from the Zod schemas:
 *
 *   apps/alineod/spec/openapi.json       — the routes
 *   apps/alineod/spec/events.schema.json  — the SSE event union
 *
 * These two files ARE alineo-as-a-protocol (research/daemon.md §2, §7, milestone L5). Run
 * with `bun run spec` from apps/alineod.
 *
 * Route ⇄ schema wiring is declared here rather than introspected from the Elysia app: the
 * routes validate with Zod directly (predictable at runtime) and the OpenAPI document is
 * generated from the same schemas here. One source of truth, two consumers.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CreateRunBody,
  CreateRunResponse,
  SpawnAgentBody,
  SpawnAgentResponse,
  TreeView,
  AgentDetail,
  StopAgentBody,
  ControlScopeBody,
  SubtreeOpResult,
  SubtreeSteerResponse,
  RunAwaitBody,
  RunAwaitResponse,
  QuiescenceView,
  NotifyOnBody,
  PromptBody,
  SteerBody,
  ResultResponse,
  TranscriptResponse,
  AlineodEvent,
  AddFactBody,
  CompactionBody,
  CompactionResultView,
  FactsResponse,
  MemoryValueBody,
  MemoryValueResponse,
  MemoryView,
} from "../src/schema";

const OUT_DIR = join(import.meta.dir, "../spec");
mkdirSync(OUT_DIR, { recursive: true });

const json = (s: z.ZodType) => z.toJSONSchema(s, { target: "openapi-3.0" });

const openapi = {
  openapi: "3.1.0",
  info: {
    title: "alineod — swarm control API",
    version: "0.0.0",
    description:
      "Initiate and orchestrate agent swarms. alineod drives OpenSandbox through the alineo SDK; " +
      "this is the language-neutral wire contract.",
  },
  servers: [
    {
      url: "http://localhost:{port}",
      description: "A self-hosted alineod. There is no hosted alineo API.",
      variables: { port: { default: "4600", description: "ALINEOD_PORT" } },
    },
  ],
  paths: {
    "/runs": {
      post: {
        summary: "Create a run (load the root agent)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: json(CreateRunBody) } },
        },
        responses: {
          "200": {
            description: "Run created",
            content: { "application/json": { schema: json(CreateRunResponse) } },
          },
          "422": { description: "Spec load failed" },
        },
      },
    },
    "/runs/{runId}": {
      get: {
        summary: "The spawn tree",
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Tree",
            content: { "application/json": { schema: json(TreeView) } },
          },
        },
      },
      delete: {
        summary: "Tear down the run (keeps the ledger)",
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": { description: "Torn down" } },
      },
    },
    "/runs/{runId}/events": {
      get: {
        summary: "SSE stream of the whole swarm",
        description:
          "text/event-stream. alineod agent_* events plus forwarded harness events, each tagged " +
          "with agentId. Honours Last-Event-ID (the ledger seq).",
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Event stream", content: { "text/event-stream": {} } } },
      },
    },
    "/runs/{runId}/agents": {
      post: {
        summary: "Spawn a child agent",
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: json(SpawnAgentBody) } },
        },
        responses: {
          "200": {
            description: "Spawned",
            content: { "application/json": { schema: json(SpawnAgentResponse) } },
          },
          "409": { description: "Budget denied / parent not live" },
        },
      },
    },
    "/agents/{agentId}": {
      get: {
        summary: "Inspect an agent",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Agent",
            content: { "application/json": { schema: json(AgentDetail) } },
          },
        },
      },
    },
    "/agents/{agentId}/prompt": {
      post: {
        summary: "Drive a turn",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: json(PromptBody) } },
        },
        responses: { "202": { description: "Accepted" } },
      },
    },
    "/agents/{agentId}/steer": {
      post: {
        summary: "Redirect the agent's current turn",
        description:
          'Steer never broadcasts (research/swarm-control.md §8a). With scope: "subtree", the agent gets one message — the steer plus a roster of its direct children — and redirects them itself.',
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: json(SteerBody) } },
        },
        responses: {
          "200": {
            description: "scope: subtree — how the parent got the message, and its roster",
            content: { "application/json": { schema: json(SubtreeSteerResponse) } },
          },
          "202": { description: "Accepted (scope: agent)" },
          "409": { description: "Agent not live" },
          "502": { description: "The bridge rejected the steer" },
        },
      },
    },
    "/agents/{agentId}/pause": {
      post: {
        summary:
          "Freeze the agent's sandbox container (or, with scope: subtree, it and every descendant)",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: false,
          content: { "application/json": { schema: json(ControlScopeBody) } },
        },
        responses: {
          "200": {
            description: "scope: subtree — one result per member, parents paused first",
            content: { "application/json": { schema: json(SubtreeOpResult) } },
          },
          "202": { description: "Accepted (scope: agent)" },
          "409": { description: "Agent not live" },
          "502": { description: "The sandbox rejected the pause" },
        },
      },
    },
    "/agents/{agentId}/resume": {
      post: {
        summary:
          "Unfreeze the agent's sandbox container (or, with scope: subtree, it and every paused descendant)",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: false,
          content: { "application/json": { schema: json(ControlScopeBody) } },
        },
        responses: {
          "200": {
            description: "scope: subtree — one result per member, children resumed first",
            content: { "application/json": { schema: json(SubtreeOpResult) } },
          },
          "202": { description: "Accepted (scope: agent)" },
          "409": { description: "Agent not paused, or not live" },
          "502": { description: "The sandbox rejected the resume" },
        },
      },
    },
    "/agents/{agentId}/stop": {
      post: {
        summary: "Abort + close an agent (or, with scope: subtree, it and every descendant)",
        description:
          "Stopping an agent that already finished closes its sandbox and emits agent_released, keeping its outcome.",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: json(StopAgentBody) } } },
        responses: {
          "200": {
            description: "scope: subtree — one result per member, leaves stopped first",
            content: { "application/json": { schema: json(SubtreeOpResult) } },
          },
          "202": { description: "Accepted (scope: agent)" },
        },
      },
    },
    "/agents/{agentId}/await": {
      get: {
        summary: "Wait until the agent's subtree is quiescent",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          { name: "scope", in: "query", schema: { type: "string", enum: ["subtree"] } },
          {
            name: "wait",
            in: "query",
            description: "Seconds to hold the request (max 240).",
            schema: { type: "number" },
          },
        ],
        responses: {
          "200": {
            description: "The subtree's quiescence — returned early once it's quiescent",
            content: { "application/json": { schema: json(QuiescenceView) } },
          },
          "404": { description: "No such agent" },
        },
      },
    },
    "/runs/{runId}/await": {
      post: {
        summary: "Wait on a set of agents (waitFor modes) or a subtree, without spawning",
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: json(RunAwaitBody) } },
        },
        responses: {
          "200": {
            description: "Resolved, or pending once `wait` ran out",
            content: { "application/json": { schema: json(RunAwaitResponse) } },
          },
          "400": { description: "Invalid body, k, or an agent not in this run" },
        },
      },
    },
    "/agents/{agentId}/notify-on": {
      post: {
        summary: "Tell this agent when each listed agent finishes (per-agent inbox)",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: json(NotifyOnBody) } },
        },
        responses: {
          "200": { description: "Subscribed" },
          "400": { description: "Unknown agent, or self-subscription" },
          "404": { description: "No such agent" },
        },
      },
    },
    "/agents/{agentId}/inbox": {
      get: {
        summary: "This agent's pending and delivered notifications",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ agentId, pending, delivered }" } },
      },
    },
    "/agents/{agentId}/inbox/deliver": {
      post: {
        summary: "Deliver pending notifications now (a new turn if the agent is idle)",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "{ delivery: steer | turn | held | dropped | none }" },
        },
      },
    },
    "/agents/{agentId}/memory": {
      get: {
        summary: "The agent's working memory, and the scope it lives under",
        description:
          "Keyed by the agent spec's resourceId (default: its name) and teamId, read from the persisted spec — so it works after the agent ended, and across an alineod restart. A spawned child starts with a copy of its parent's memory.",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
            description: "Entries per page, in sorted key order.",
          },
          {
            name: "after",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Return keys after this one — the previous page's `nextAfter`.",
          },
        ],
        responses: {
          "200": {
            description: "One page of working memory",
            content: { "application/json": { schema: json(MemoryView) } },
          },
          "400": { description: "Bad limit" },
          "404": { description: "No such agent" },
          "501": { description: "Memory is disabled on this alineod" },
        },
      },
    },
    "/agents/{agentId}/memory/{key}": {
      get: {
        summary: "One working-memory value",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          { name: "key", in: "path", required: true, schema: { type: "string", maxLength: 256 } },
        ],
        responses: {
          "200": {
            description: "The value",
            content: { "application/json": { schema: json(MemoryValueResponse) } },
          },
          "400": { description: "Key is empty or longer than 256 characters" },
          "404": { description: "No such agent, or no such key" },
          "501": { description: "Memory is disabled on this alineod" },
        },
      },
      put: {
        summary: "Set a working-memory value (any JSON, at most 64 KiB)",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          { name: "key", in: "path", required: true, schema: { type: "string", maxLength: 256 } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: json(MemoryValueBody) } },
        },
        responses: {
          "200": {
            description: "Stored",
            content: { "application/json": { schema: json(MemoryValueResponse) } },
          },
          "400": { description: "Bad key, or a value that is missing, too large or not JSON" },
          "404": { description: "No such agent" },
          "501": { description: "Memory is disabled on this alineod" },
        },
      },
      delete: {
        summary: "Remove a working-memory key (idempotent)",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          { name: "key", in: "path", required: true, schema: { type: "string", maxLength: 256 } },
        ],
        responses: {
          "204": { description: "Removed, or never there" },
          "400": { description: "Key is empty or longer than 256 characters" },
          "404": { description: "No such agent" },
          "501": { description: "Memory is disabled on this alineod" },
        },
      },
    },
    "/agents/{agentId}/facts": {
      post: {
        summary: "Remember a fact (semantic memory)",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: json(AddFactBody) } },
        },
        responses: {
          "201": { description: "Remembered" },
          "400": { description: "Invalid body" },
          "404": { description: "No such agent" },
          "501": { description: "Memory disabled, or no embeddings endpoint configured" },
          "502": { description: "The embeddings provider failed" },
        },
      },
      get: {
        summary: "Recall facts by meaning (?query=), or list every fact newest-first",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          { name: "query", in: "query", required: false, schema: { type: "string" } },
          {
            name: "topK",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 5 },
            description: "With ?query= only.",
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
            description: "Without ?query= only.",
          },
        ],
        responses: {
          "200": {
            description: "Facts",
            content: { "application/json": { schema: json(FactsResponse) } },
          },
          "400": { description: "Bad topK or limit" },
          "404": { description: "No such agent" },
          "501": { description: "Memory disabled, or no embeddings endpoint configured" },
          "502": { description: "The embeddings provider failed" },
        },
      },
    },
    "/agents/{agentId}/compactions": {
      post: {
        summary: "Prune old or excess facts now",
        description:
          "Age-based removal runs first, then the count cap. Neither set removes nothing. Independent of the automatic pass ALINEOD_MEMORY_MAX_FACTS / ALINEOD_MEMORY_MAX_AGE_MS run after each remembered fact.",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: false,
          content: { "application/json": { schema: json(CompactionBody) } },
        },
        responses: {
          "200": {
            description: "What was removed",
            content: { "application/json": { schema: json(CompactionResultView) } },
          },
          "400": { description: "Invalid body" },
          "404": { description: "No such agent" },
          "501": { description: "Memory disabled, or no embeddings endpoint configured" },
        },
      },
    },
    "/agents/{agentId}/transcript": {
      get: {
        summary: "What the agent said and did, turn by turn (messages, tool calls, errors)",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "full",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["1"] },
            description: "Don't shorten long text; include the model's thinking.",
          },
        ],
        responses: {
          "200": {
            description: "One entry per finished turn",
            content: { "application/json": { schema: json(TranscriptResponse) } },
          },
          "404": { description: "No such agent" },
        },
      },
    },
    "/agents/{agentId}/result": {
      get: {
        summary: "Resolve a handle",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "wait",
            in: "query",
            required: false,
            schema: { type: "integer" },
            description: "Long-poll seconds.",
          },
        ],
        responses: {
          "200": {
            description: "Settled",
            content: { "application/json": { schema: json(ResultResponse) } },
          },
          "202": {
            description: "Still pending",
            content: { "application/json": { schema: json(ResultResponse) } },
          },
        },
      },
    },
  },
};

/**
 * Every operation's `operationId` and `description`. Agents that turn an OpenAPI spec into
 * function-calling tools use the id as the tool name and the description as its prompt, so each
 * must be unique and say when to call the operation. Keyed `METHOD /path`; the loop below throws
 * if an operation has no entry or an entry has no operation.
 */
const OPERATIONS: Record<string, { operationId: string; description: string }> = {
  "POST /runs": {
    operationId: "createRun",
    description:
      "Start a run by loading a root agent from an agent spec. Returns the run id and the root agent id. Call this first; every other operation needs the ids it returns.",
  },
  "GET /runs/{runId}": {
    operationId: "getRunTree",
    description:
      "Return the whole spawn tree of a run: each agent, its parent, and its state. Use it to see what is running before you steer, pause, or stop.",
  },
  "DELETE /runs/{runId}": {
    operationId: "deleteRun",
    description:
      "Tear down every sandbox in the run. The ledger is kept, so the run can still be read and replayed afterward.",
  },
  "GET /runs/{runId}/events": {
    operationId: "streamRunEvents",
    description:
      "Open a server-sent event stream of everything the swarm does. Reconnect with Last-Event-ID to resume without gaps.",
  },
  "POST /runs/{runId}/agents": {
    operationId: "spawnAgent",
    description:
      "Spawn a child agent under a parent in this run. The budget (spawnDepth, maxAgents) is checked first and a denied spawn returns 409.",
  },
  "GET /agents/{agentId}": {
    operationId: "getAgent",
    description:
      "Return one agent's state, spec, parent, and sandbox. Use it to check whether an agent is live before you send it a command.",
  },
  "POST /agents/{agentId}/prompt": {
    operationId: "promptAgent",
    description:
      "Send a prompt to an agent and start a turn. The call returns at once with 202. Read progress from the event stream and the final output from getAgentResult.",
  },
  "POST /agents/{agentId}/steer": {
    operationId: "steerAgent",
    description:
      "Redirect an agent in the middle of a turn. With scope subtree, the agent gets the steer and a list of its children and passes it on itself. Nothing is broadcast.",
  },
  "POST /agents/{agentId}/pause": {
    operationId: "pauseAgent",
    description:
      "Freeze the agent's sandbox container. With scope subtree, freeze every descendant too, parents first. Undo with resumeAgent.",
  },
  "POST /agents/{agentId}/resume": {
    operationId: "resumeAgent",
    description:
      "Unfreeze a paused agent's sandbox. With scope subtree, unfreeze every paused descendant too, children first.",
  },
  "POST /agents/{agentId}/stop": {
    operationId: "stopAgent",
    description:
      "Abort the agent's turn and close its sandbox. With scope subtree, stop every descendant too, leaves first. A finished agent keeps its outcome.",
  },
  "GET /agents/{agentId}/await": {
    operationId: "awaitAgentQuiescent",
    description:
      "Hold the request until the agent's subtree has no work left, or until wait seconds pass. Use it instead of polling.",
  },
  "POST /runs/{runId}/await": {
    operationId: "awaitRun",
    description:
      "Wait on a set of agents with a waitFor mode (all, any, or k of n), or on a subtree, without spawning anything.",
  },
  "POST /agents/{agentId}/notify-on": {
    operationId: "subscribeAgentNotifications",
    description:
      "Tell this agent when each listed agent finishes. Notices go into the agent's inbox and are delivered between turns.",
  },
  "GET /agents/{agentId}/inbox": {
    operationId: "getAgentInbox",
    description: "List an agent's pending and delivered notifications.",
  },
  "POST /agents/{agentId}/inbox/deliver": {
    operationId: "deliverAgentInbox",
    description:
      "Deliver pending notifications now. If the agent is idle, this starts a new turn. The response says how each was delivered.",
  },
  "GET /agents/{agentId}/memory": {
    operationId: "listAgentMemory",
    description:
      "List an agent's working-memory entries in key order, one page at a time. Pass nextAfter from the last page as after to continue.",
  },
  "GET /agents/{agentId}/memory/{key}": {
    operationId: "getAgentMemoryValue",
    description: "Read one working-memory value by key. Returns 404 if the key is not set.",
  },
  "PUT /agents/{agentId}/memory/{key}": {
    operationId: "setAgentMemoryValue",
    description: "Write one working-memory value. The value can be any JSON up to 64 KiB.",
  },
  "DELETE /agents/{agentId}/memory/{key}": {
    operationId: "deleteAgentMemoryValue",
    description: "Delete one working-memory key. The call succeeds if the key was never set.",
  },
  "POST /agents/{agentId}/facts": {
    operationId: "addAgentFact",
    description:
      "Store a fact in the agent's semantic memory. Needs an embeddings endpoint configured on this alineod.",
  },
  "GET /agents/{agentId}/facts": {
    operationId: "recallAgentFacts",
    description:
      "Find facts by meaning with ?query=, or list every fact newest-first without it. Use topK with a query and limit without one.",
  },
  "POST /agents/{agentId}/compactions": {
    operationId: "compactAgentFacts",
    description:
      "Remove old or excess facts now. Age-based removal runs first, then the count cap. Returns what was removed.",
  },
  "GET /agents/{agentId}/transcript": {
    operationId: "getAgentTranscript",
    description:
      "Return what the agent said and did, one entry per finished turn: messages, tool calls, and errors. Pass full=1 for untruncated text and the model's thinking.",
  },
  "GET /agents/{agentId}/result": {
    operationId: "getAgentResult",
    description:
      "Resolve an agent's result. Returns 200 when settled and 202 while pending. Pass wait to long-poll for up to that many seconds.",
  },
};

const seen = new Set<string>();
for (const [path, item] of Object.entries(openapi.paths)) {
  for (const [method, op] of Object.entries(item)) {
    const key = `${method.toUpperCase()} ${path}`;
    const doc = OPERATIONS[key];
    if (!doc) throw new Error(`emit-spec: no operationId/description for ${key}`);
    if (seen.has(doc.operationId))
      throw new Error(`emit-spec: duplicate operationId ${doc.operationId}`);
    seen.add(doc.operationId);
    // Keep any longer note already written on the operation; the new text leads.
    const prior = (op as { description?: string }).description;
    Object.assign(op, {
      operationId: doc.operationId,
      description: prior ? `${doc.description} ${prior}` : doc.description,
    });
  }
}
for (const key of Object.keys(OPERATIONS)) {
  const [method, path] = key.split(" ");
  if (!(openapi.paths as Record<string, Record<string, unknown>>)[path]?.[method.toLowerCase()]) {
    throw new Error(`emit-spec: OPERATIONS has ${key} but the spec has no such operation`);
  }
}

writeFileSync(join(OUT_DIR, "openapi.json"), JSON.stringify(openapi, null, 2) + "\n");
writeFileSync(
  join(OUT_DIR, "events.schema.json"),
  JSON.stringify(json(AlineodEvent), null, 2) + "\n",
);

console.log(`wrote ${join(OUT_DIR, "openapi.json")}`);
console.log(`wrote ${join(OUT_DIR, "events.schema.json")}`);
