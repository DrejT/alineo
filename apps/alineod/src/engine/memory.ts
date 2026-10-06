/**
 * alineod's memory layer — the daemon-side counterpart to `opts.memory` on `Alineo.start()` /
 * `.resume()` / `.reattach()`.
 *
 * The SDK never builds a `Memory` on its own ("own the pipeline, don't assume a backend"), so a
 * daemon that wants its agents to remember anything has to build one and hand it to every agent
 * it creates. alineod does that once, here: one durable SQLite-backed `Memory`, shared by every
 * agent it drives, scoped per agent by `ResourceRef` (the spec's `resourceId`/`teamId`).
 *
 * Why one shared instance is right:
 *
 * - `Alineo.spawn()` copies the parent's `.memory` onto the child and forks the parent's scope
 *   into the child's (`Memory.fork`) — which only works if parent and child hold the *same*
 *   store. Passing the same instance to every `start`/`resume`/`reattach` is what makes that
 *   true after a restart too: a rehydrated parent still forks into its next child.
 * - Memory is keyed by `resourceId`, not sandbox id, so it survives everything the sandbox
 *   doesn't — a lost container, a restore-from-checkpoint onto a different sandbox, an alineod
 *   restart. Nothing here is rebuilt from the ledger; the SQLite file is the source of truth for
 *   it, which is why `ops/backup.ts` copies it too.
 *
 * Disabled (`ALINEOD_MEMORY_ENABLED=false`) means `getMemoryStore()` is `undefined`, agents are started
 * with no `.memory` exactly as before this layer existed, and the memory routes answer 501.
 */
import type {
  EmbeddingProvider,
  IPrunableSemanticMemoryProvider,
  ResourceRef,
} from "@alineo-labs/memory";
import { Memory } from "@alineo-labs/memory";
import {
  SQLiteSemanticMemoryProvider,
  SQLiteWorkingMemoryProvider,
} from "@alineo-labs/sqlite-memory";
import { getLogger } from "@alineo-labs/logger";
import {
  MEMORY_DB_PATH,
  MEMORY_EMBEDDINGS_API_KEY,
  MEMORY_EMBEDDINGS_ASYMMETRIC,
  MEMORY_EMBEDDINGS_MODEL,
  MEMORY_EMBEDDINGS_TIMEOUT_MS,
  MEMORY_EMBEDDINGS_URL,
  MEMORY_ENABLED,
  MEMORY_MAX_AGE_MS,
  MEMORY_MAX_FACTS,
} from "../../config";

const log = getLogger("alineod");

export interface EmbeddingsConfig {
  url: string;
  model: string;
  apiKey?: string;
  /** Send `input_type: "passage" | "query"` — see `ALINEOD_MEMORY_EMBEDDINGS_ASYMMETRIC`. */
  asymmetric?: boolean;
  timeoutMs: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * An `EmbeddingProvider` over any OpenAI-compatible `/v1/embeddings` endpoint.
 *
 * Strict about the response, because a silently wrong vector is worse than an error: it gets
 * stored, and then every later `recall()` ranks against garbage with nothing to flag it. The
 * count must match the input, every vector must be a non-empty array of finite numbers, and
 * `index` (when the server sends it) is honoured so a reordered response can't pair a vector with
 * the wrong text. The API key never appears in an error message.
 */
export function createEmbeddingProvider(config: EmbeddingsConfig): EmbeddingProvider {
  const doFetch = config.fetch ?? fetch;
  return {
    id: `openai-compatible:${config.model}`,
    async embed(texts, opts) {
      if (texts.length === 0) return [];
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      const body: Record<string, unknown> = { model: config.model, input: texts };
      if (config.asymmetric) body.input_type = opts?.type ?? "query";

      // An explicit controller + timer rather than `AbortSignal.timeout()`: that timer is
      // unref'd, so a hung request with nothing else keeping the loop alive never fires it.
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.timeoutMs);
      let res: Response;
      try {
        res = await doFetch(config.url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        const reason = timedOut
          ? `timed out after ${config.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
        clearTimeout(timer);
        throw new Error(`embeddings request failed: ${reason}`);
      }
      // The timer stays armed through the body read: a server that sends headers and then stalls
      // would otherwise hang the caller exactly as a server that never answers would.
      let detail = "";
      let json = null as { data?: Array<{ embedding?: unknown; index?: unknown }> } | null;
      try {
        if (res.ok) json = (await res.json().catch(() => null)) as typeof json;
        // The body of an error response can echo the request; keep only a bounded prefix.
        else detail = (await res.text().catch(() => "")).slice(0, 200);
      } finally {
        clearTimeout(timer);
      }
      if (timedOut)
        throw new Error(`embeddings request failed: timed out after ${config.timeoutMs}ms`);
      if (!res.ok) {
        throw new Error(
          `embeddings request failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`,
        );
      }
      const data = json?.data;
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error(
          `embeddings response malformed: expected ${texts.length} vectors, got ${
            Array.isArray(data) ? data.length : "none"
          }`,
        );
      }
      const ordered = data.every((d) => typeof d.index === "number")
        ? [...data].sort((a, b) => (a.index as number) - (b.index as number))
        : data;
      return ordered.map((d, i) => {
        const v = d.embedding;
        if (!Array.isArray(v) || v.length === 0 || !v.every((n) => Number.isFinite(n))) {
          throw new Error(`embeddings response malformed: vector ${i} is not an array of numbers`);
        }
        return v as number[];
      });
    },
  };
}

export interface BuildMemoryOptions {
  dbPath: string;
  /** Omit for working memory only. */
  embeddings?: EmbeddingProvider;
  /** `0`/unset = unbounded. */
  maxFacts?: number;
  /** `0`/unset = facts never expire. */
  maxAgeMs?: number;
}

/**
 * The `Memory` facade plus the semantic provider behind it. `Memory` keeps its provider private
 * and has no "list every fact" method, so the facts route holds the provider too — the same
 * `listAll` capability `Memory.fork()` and compaction use internally.
 */
export interface MemoryStore {
  memory: Memory;
  semantic?: IPrunableSemanticMemoryProvider;
}

/** Assemble a `Memory` over one SQLite file. Exported for tests; `initMemory()` is the daemon's way in. */
export function buildMemory(opts: BuildMemoryOptions): MemoryStore {
  const working = new SQLiteWorkingMemoryProvider(opts.dbPath);
  const semantic = opts.embeddings
    ? new SQLiteSemanticMemoryProvider(opts.dbPath, opts.embeddings)
    : undefined;
  const bounded = (opts.maxFacts ?? 0) > 0 || (opts.maxAgeMs ?? 0) > 0;
  const memory = new Memory({
    workingMemory: working,
    semantic,
    autoCompact:
      semantic && bounded
        ? {
            maxFacts: opts.maxFacts || undefined,
            maxAgeMs: opts.maxAgeMs || undefined,
          }
        : undefined,
  });
  return { memory, semantic };
}

let current: MemoryStore | undefined;
let initialised = false;

/**
 * Open the memory store. Called once at boot by `server.ts` so a bad path or an unloadable
 * database stops the daemon with a clear error, rather than surfacing on the first agent spawn
 * minutes later; `getMemoryStore()` also calls it lazily so tests and scripts need no ceremony.
 */
export function initMemory(): MemoryStore | undefined {
  if (initialised) return current;
  initialised = true;
  if (!MEMORY_ENABLED) {
    log.info("memory disabled (ALINEOD_MEMORY_ENABLED=false)");
    return undefined;
  }
  const wantsSemantic = MEMORY_EMBEDDINGS_URL !== "" || MEMORY_EMBEDDINGS_MODEL !== "";
  if (wantsSemantic && (MEMORY_EMBEDDINGS_URL === "" || MEMORY_EMBEDDINGS_MODEL === "")) {
    // Half-configured is almost certainly a typo; refusing beats silently running without the
    // semantic memory the operator thinks they turned on.
    throw new Error(
      "ALINEOD_MEMORY_EMBEDDINGS_URL and ALINEOD_MEMORY_EMBEDDINGS_MODEL must be set together",
    );
  }
  current = buildMemory({
    dbPath: MEMORY_DB_PATH,
    embeddings: wantsSemantic
      ? createEmbeddingProvider({
          url: MEMORY_EMBEDDINGS_URL,
          model: MEMORY_EMBEDDINGS_MODEL,
          apiKey: MEMORY_EMBEDDINGS_API_KEY || undefined,
          asymmetric: MEMORY_EMBEDDINGS_ASYMMETRIC,
          timeoutMs: MEMORY_EMBEDDINGS_TIMEOUT_MS,
        })
      : undefined,
    maxFacts: MEMORY_MAX_FACTS,
    maxAgeMs: MEMORY_MAX_AGE_MS,
  });
  log.info("memory ready", {
    path: MEMORY_DB_PATH,
    semantic: current.memory.hasSemanticMemory,
    maxFacts: MEMORY_MAX_FACTS || undefined,
    maxAgeMs: MEMORY_MAX_AGE_MS || undefined,
  });
  return current;
}

/** The daemon's shared memory store, or `undefined` when memory is disabled. */
export function getMemoryStore(): MemoryStore | undefined {
  return initMemory();
}

/**
 * Spread into every `Alineo.start()` / `.resume()` / `.reattach()` options object, so the call
 * site can't forget it — `{}` when memory is disabled, which leaves `.memory` unset.
 */
export function memoryOptions(): { memory?: Memory } {
  const store = getMemoryStore();
  return store ? { memory: store.memory } : {};
}

/**
 * Working-memory reads and deletes, as named functions rather than `.get(` / `.delete(` calls at
 * the route: `scripts/check-vocabulary.ts` counts those substrings as route registrations in
 * `src/routes/`, and a provider method sharing the name would fail its "every route has a
 * literal path" floor.
 */
export function readWorking(store: MemoryStore, ref: ResourceRef, key: string): Promise<unknown> {
  return store.memory.workingMemory.get(ref, key);
}

export function removeWorking(store: MemoryStore, ref: ResourceRef, key: string): Promise<void> {
  return store.memory.workingMemory.delete(ref, key);
}

/**
 * The scope an agent's memory lives under, derived the way `Alineo.resourceRef` derives it:
 * `resourceId ?? name`, plus the optional `teamId`. Read from the persisted spec rather than the
 * live `Alineo` handle so memory stays reachable after the agent ended, was lost, or alineod
 * restarted before it reconnected.
 */
export function agentResourceRef(specJson: string, fallbackName: string): ResourceRef {
  let spec: { name?: unknown; resourceId?: unknown; teamId?: unknown } = {};
  try {
    spec = JSON.parse(specJson) as typeof spec;
  } catch {
    /* fall back to the row's own name below */
  }
  const resourceId =
    typeof spec.resourceId === "string" && spec.resourceId !== ""
      ? spec.resourceId
      : typeof spec.name === "string" && spec.name !== ""
        ? spec.name
        : fallbackName;
  return typeof spec.teamId === "string" && spec.teamId !== ""
    ? { resourceId, teamId: spec.teamId }
    : { resourceId };
}

/** Test seam: swap the shared store (or `undefined` to simulate disabled). @internal */
export function installMemoryForTests(store: MemoryStore | undefined): void {
  current = store;
  initialised = true;
}

/** Test seam: forget the shared store so the next `getMemoryStore()` re-reads the config. @internal */
export function resetMemoryForTests(): void {
  current = undefined;
  initialised = false;
}
