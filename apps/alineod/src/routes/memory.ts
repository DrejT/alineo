/**
 * Memory routes — an agent's durable memory, over HTTP.
 *
 *   GET    /agents/:agentId/memory          working memory (paged: ?limit=&after=) + its scope
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
  EmbeddingsError,
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
const DEFAULT_KEY_LIMIT = 100;
const MAX_KEY_LIMIT = 1_000;

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

/**
 * Run an operation that calls the embeddings provider. Only a failure the provider itself
 * reported becomes a 502 — anything else (a SQLite error, a bug) is rethrown untouched, so it
 * surfaces as the 500 it is instead of sending an operator after an embeddings outage that
 * isn't there.
 */
async function viaEmbeddings<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof EmbeddingsError) {
      throw new HttpError(502, `embeddings provider failed: ${errorMessage(err)}`);
    }
    if (err instanceof MemoryCapabilityError) throw new HttpError(501, err.message);
    throw err;
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
  .get("/agents/:agentId/memory", async ({ params, query }) => {
    const { store, ref } = scopeOf(params.agentId);
    const limit = intParam(query.limit, "limit", DEFAULT_KEY_LIMIT, MAX_KEY_LIMIT);
    const after = typeof query.after === "string" && query.after !== "" ? query.after : undefined;

    // Keyed pages in sorted key order. The provider has no ranged read, so this still loads the
    // resource's entries — what it bounds is the response, which is the part that scales with
    // 64 KiB values: a routine read no longer ships the whole map.
    const all = await store.memory.workingMemory.list(ref);
    const keys = Object.keys(all).sort();
    const from = after === undefined ? 0 : keys.findIndex((k) => k > after);
    const page = from === -1 ? [] : keys.slice(from, from + limit);
    const more = from !== -1 && from + limit < keys.length;
    return {
      agentId: params.agentId,
      resourceRef: ref,
      semantic: store.memory.hasSemanticMemory,
      working: Object.fromEntries(page.map((k) => [k, all[k]])),
      ...(more ? { nextAfter: page[page.length - 1] } : {}),
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
    // A bounded, indexed read — not every fact the resource ever remembered, sorted in JS.
    const facts = (await store.semantic?.listRecent(ref, limit)) ?? [];
    return { agentId: params.agentId, query: null, facts };
  })

  .post("/agents/:agentId/compactions", async ({ params, body }) => {
    const { store, ref } = scopeOf(params.agentId);
    requireSemantic(store);
    const opts = parseBody(CompactionBody, body ?? {});
    // No `viaEmbeddings`: compaction without a `summarize` callback never calls the embeddings
    // provider, so a failure here is local storage, and says so.
    return store.memory.compactSemanticMemory(ref, opts);
  });
