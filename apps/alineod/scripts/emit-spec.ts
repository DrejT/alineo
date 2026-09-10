/**
 * Emit the language-neutral protocol artifacts from the Zod schemas:
 *
 *   specs/alineod/openapi.json       — the routes
 *   specs/alineod/events.schema.json  — the SSE event union
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
  PromptBody,
  ResultResponse,
  AlineodEvent,
} from "../src/schema";

const OUT_DIR = join(import.meta.dir, "../../../specs/alineod");
mkdirSync(OUT_DIR, { recursive: true });

const json = (s: z.ZodType) => z.toJSONSchema(s, { target: "openapi-3.0" });

const openapi = {
  openapi: "3.1.0",
  info: {
    title: "alineod — swarm control API",
    version: "0.0.0",
    description:
      "Initiate and orchestrate agent swarms. alineod drives OpenSandbox through the alineo SDK; " +
      "this is the language-neutral wire contract. Prototype.",
  },
  paths: {
    "/runs": {
      post: {
        summary: "Create a run (load the root agent)",
        requestBody: { required: true, content: { "application/json": { schema: json(CreateRunBody) } } },
        responses: {
          "200": { description: "Run created", content: { "application/json": { schema: json(CreateRunResponse) } } },
          "422": { description: "Spec load failed" },
        },
      },
    },
    "/runs/{runId}": {
      get: {
        summary: "The spawn tree",
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Tree", content: { "application/json": { schema: json(TreeView) } } } },
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
        requestBody: { required: true, content: { "application/json": { schema: json(SpawnAgentBody) } } },
        responses: {
          "200": { description: "Spawned", content: { "application/json": { schema: json(SpawnAgentResponse) } } },
          "409": { description: "Budget denied / parent not live" },
        },
      },
    },
    "/agents/{agentId}": {
      get: {
        summary: "Inspect an agent",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Agent", content: { "application/json": { schema: json(AgentDetail) } } } },
      },
    },
    "/agents/{agentId}/prompt": {
      post: {
        summary: "Drive a turn",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: json(PromptBody) } } },
        responses: { "202": { description: "Accepted" } },
      },
    },
    "/agents/{agentId}/stop": {
      post: {
        summary: "Abort + close an agent",
        parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: json(StopAgentBody) } } },
        responses: { "202": { description: "Accepted" } },
      },
    },
    "/agents/{agentId}/result": {
      get: {
        summary: "Resolve a handle",
        parameters: [
          { name: "agentId", in: "path", required: true, schema: { type: "string" } },
          { name: "wait", in: "query", required: false, schema: { type: "integer" }, description: "Long-poll seconds." },
        ],
        responses: {
          "200": { description: "Settled", content: { "application/json": { schema: json(ResultResponse) } } },
          "202": { description: "Still pending", content: { "application/json": { schema: json(ResultResponse) } } },
        },
      },
    },
  },
};

writeFileSync(join(OUT_DIR, "openapi.json"), JSON.stringify(openapi, null, 2) + "\n");
writeFileSync(join(OUT_DIR, "events.schema.json"), JSON.stringify(json(AlineodEvent), null, 2) + "\n");

console.log(`wrote ${join(OUT_DIR, "openapi.json")}`);
console.log(`wrote ${join(OUT_DIR, "events.schema.json")}`);
