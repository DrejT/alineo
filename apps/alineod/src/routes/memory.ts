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
import { MemoryCapabilityError, isPageable, isRecentListable } from "@alineo-labs/memory";
import type { ResourceRef } from "@alineo-labs/memory";
import { AddFactBody, CompactionBody, MEMORY_KEY_MAX_CHARS, MemoryValueBody } from "../schema";
import { getAgentRow } from "../state/projection";
import {
  EmbeddingsError,
  agentResourceRef,
  compareUtf8,
  getMemoryStore,
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

/**
 * One page of working memory. A backend with an ordered index answers it directly
 * (`listPage`); one without is read whole and sliced, in the *same* order, so a client sees
 * identical pages whichever backend is behind alineod.
 */
async function workingPage(
  store: MemoryStore,
  ref: ResourceRef,
  after: string | undefined,
  limit: number,
): Promise<{ entries: Array<[string, unknown]>; more: boolean }> {
  if (isPageable(store.working)) return store.working.listPage(ref, { after, limit });
  const all = await store.memory.workingMemory.list(ref);
  const keys = Object.keys(all)
    .filter((k) => after === undefined || compareUtf8(k, after) > 0)
    .sort(compareUtf8);
  return {
    entries: keys.slice(0, limit).map((k): [string, unknown] => [k, all[k]]),
    more: keys.length > limit,
  };
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

    // Pages in key order. On a backend that can seek (SQLite does, via its primary-key index) the
    // cost follows `limit`, not how many keys the agent has stored.
    const { entries, more } = await workingPage(store, ref, after, limit);
    return {
      agentId: params.agentId,
      resourceRef: ref,
      semantic: store.memory.hasSemanticMemory,
      working: Object.fromEntries(entries),
      // From the ordered list, never from the object: `Object.keys` would hand back `"10"` after
      // `"9"` and put the cursor on the wrong key.
      ...(more ? { nextAfter: entries[entries.length - 1]![0] } : {}),
    };
  })

  .get("/agents/:agentId/memory/:key", async ({ params }) => {
    const { store, ref } = scopeOf(params.agentId);
    const key = checkKey(params.key);
    const value = await store.memory.workingMemory.get(ref, key);
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
    await store.memory.workingMemory.delete(ref, checkKey(params.key));
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
    const sem = store.semantic;
    // Reachable only if a store was assembled with a semantic `Memory` but no provider handle to
    // list from. An empty list would read as "no facts"; say what is actually wrong.
    if (!sem) throw new HttpError(501, "this memory store cannot list facts");
    // A backend that can answer "the newest N" does (SQLite, off an index). One that can't is
    // read whole and cut down here — slower, but correct, and not silently empty.
    const facts = isRecentListable(sem)
      ? await sem.listRecent(ref, limit)
      : (await sem.listAll(ref)).sort((a, b) => b.rememberedAt - a.rememberedAt).slice(0, limit);
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
