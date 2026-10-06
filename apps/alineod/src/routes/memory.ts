/**
 * Memory routes — an agent's durable memory, over HTTP.
 *
 *   GET    /agents/:agentId/memory          working memory + the scope it lives under
 *   GET    /agents/:agentId/memory/:key     one working-memory value
 *   PUT    /agents/:agentId/memory/:key     set it   (body: { value })
 *   DELETE /agents/:agentId/memory/:key     remove it (idempotent)
 *   POST   /agents/:agentId/facts           remember a fact
 *   GET    /agents/:agentId/facts           ?query=… → semantic recall (?topK=), else every fact
 *   POST   /agents/:agentId/compactions     prune old/excess facts now
 *
 * Keyed by the agent's `ResourceRef`, read from its persisted spec — NOT from the live handle. An
 * agent that has ended, was lost, or hasn't been reconnected since alineod restarted still has
 * memory worth reading, and a live-only route would answer 409 exactly when an operator wants it.
 *
 * Disabled memory and an unconfigured semantic provider are 501, not 404: the route exists, this
 * deployment doesn't implement it. A failing embeddings provider is 502 — the upstream's fault,
 * not a bad request and not an alineod bug.
 */
import { Elysia } from "elysia";
import { MemoryCapabilityError } from "@alineo-labs/memory";
import type { ResourceRef } from "@alineo-labs/memory";
import { AddFactBody, CompactionBody, MEMORY_KEY_MAX_CHARS, MemoryValueBody } from "../schema";
import { getAgentRow } from "../state/projection";
import {
  agentResourceRef,
  getMemoryStore,
  readWorking,
  removeWorking,
  type MemoryStore,
} from "../engine/memory";
import { HttpError } from "../engine/errors";
import { errorMessage } from "../util";
import { parseBody } from "./http";

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 100;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;

function scopeOf(agentId: string): { store: MemoryStore; ref: ResourceRef } {
  const row = getAgentRow(agentId);
  if (!row) throw new HttpError(404, `no agent ${agentId}`);
  const store = getMemoryStore();
  if (!store) {
    throw new HttpError(501, "memory is disabled on this alineod (ALINEOD_MEMORY_ENABLED=false)");
  }
  return { store, ref: agentResourceRef(row.spec_json, row.spec_name) };
}

function requireSemantic(store: MemoryStore): void {
  if (!store.memory.hasSemanticMemory) {
    throw new HttpError(
      501,
      "semantic memory is not configured (set ALINEOD_MEMORY_EMBEDDINGS_URL and ALINEOD_MEMORY_EMBEDDINGS_MODEL)",
    );
  }
}

/** Run a semantic operation, turning an embeddings-provider failure into a 502. */
async function viaEmbeddings<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof MemoryCapabilityError) throw new HttpError(501, err.message);
    throw new HttpError(502, `embeddings provider failed: ${errorMessage(err)}`);
  }
}

function checkKey(key: string): string {
  if (key.length === 0 || key.length > MEMORY_KEY_MAX_CHARS) {
    throw new HttpError(400, `key must be 1-${MEMORY_KEY_MAX_CHARS} characters`);
  }
  return key;
}

/** `?name=` as a bounded positive integer, or `fallback` when absent. */
function intParam(raw: string | undefined, name: string, fallback: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new HttpError(400, `${name} must be an integer between 1 and ${max}`);
  }
  return n;
}

export const memoryRoutes = new Elysia()
  .get("/agents/:agentId/memory", async ({ params }) => {
    const { store, ref } = scopeOf(params.agentId);
    return {
      agentId: params.agentId,
      resourceRef: ref,
      semantic: store.memory.hasSemanticMemory,
      working: await store.memory.workingMemory.list(ref),
    };
  })

  .get("/agents/:agentId/memory/:key", async ({ params }) => {
    const { store, ref } = scopeOf(params.agentId);
    const key = checkKey(params.key);
    const value = await readWorking(store, ref, key);
    if (value === undefined) throw new HttpError(404, `no memory key ${key} for ${params.agentId}`);
    return { key, value };
  })

  .put("/agents/:agentId/memory/:key", async ({ params, body }) => {
    const { store, ref } = scopeOf(params.agentId);
    const key = checkKey(params.key);
    const { value } = parseBody(MemoryValueBody, body);
    await store.memory.workingMemory.set(ref, key, value);
    return { key, value };
  })

  .delete("/agents/:agentId/memory/:key", async ({ params }) => {
    const { store, ref } = scopeOf(params.agentId);
    await removeWorking(store, ref, checkKey(params.key));
    return new Response(null, { status: 204 });
  })

  .post("/agents/:agentId/facts", async ({ params, body, set }) => {
    const { store, ref } = scopeOf(params.agentId);
    requireSemantic(store);
    const { content, sourceRef } = parseBody(AddFactBody, body);
    await viaEmbeddings(() => store.memory.remember(ref, { content, sourceRef }));
    set.status = 201;
    return { agentId: params.agentId, remembered: true, verified: sourceRef !== undefined };
  })

  .get("/agents/:agentId/facts", async ({ params, query }) => {
    const { store, ref } = scopeOf(params.agentId);
    requireSemantic(store);
    const q = typeof query.query === "string" ? query.query : "";
    if (q !== "") {
      const topK = intParam(query.topK, "topK", DEFAULT_TOP_K, MAX_TOP_K);
      const facts = await viaEmbeddings(() => store.memory.recall(ref, q, { topK }));
      return { agentId: params.agentId, query: q, facts };
    }
    const limit = intParam(query.limit, "limit", DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const all = (await store.semantic?.listAll(ref)) ?? [];
    all.sort((a, b) => b.rememberedAt - a.rememberedAt);
    return { agentId: params.agentId, query: null, facts: all.slice(0, limit) };
  })

  .post("/agents/:agentId/compactions", async ({ params, body }) => {
    const { store, ref } = scopeOf(params.agentId);
    requireSemantic(store);
    const opts = parseBody(CompactionBody, body ?? {});
    return viaEmbeddings(() => store.memory.compactSemanticMemory(ref, opts));
  });
