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
  IWorkingMemoryProvider,
  ResourceRef,
} from "@alineo-labs/memory";
import { Memory } from "@alineo-labs/memory";
import { resourceRefOf } from "@alineo-labs/schema";
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

/**
 * The embeddings provider failed: unreachable, timed out, an HTTP error, or an answer that can't
 * be trusted. A distinct type so the routes can tell "the upstream is down" (502) from a local
 * failure such as a SQLite error (500) — relabelling the second as the first sends an operator
 * chasing an outage that isn't there.
 */
export class EmbeddingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingsError";
  }
}

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
        throw new EmbeddingsError(`embeddings request failed: ${reason}`);
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
        throw new EmbeddingsError(
          `embeddings request failed: timed out after ${config.timeoutMs}ms`,
        );
      if (!res.ok) {
        throw new EmbeddingsError(
          `embeddings request failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`,
        );
      }
      const data = json?.data;
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new EmbeddingsError(
          `embeddings response malformed: expected ${texts.length} vectors, got ${
            Array.isArray(data) ? data.length : "none"
          }`,
        );
      }
      // `index` pairs each vector with its input. Either no entry carries one (positional), or
      // every entry does and together they are exactly 0..n-1: a duplicate, a gap or an
      // out-of-range value means the server's pairing can't be trusted, and sorting by it anyway
      // would store a vector against the wrong text with nothing to flag it.
      let ordered: typeof data = data;
      if (data.some((d) => d.index !== undefined)) {
        const slots: typeof data = new Array(data.length);
        for (const d of data) {
          const at = d.index;
          if (
            typeof at !== "number" ||
            !Number.isInteger(at) ||
            at < 0 ||
            at >= data.length ||
            slots[at] !== undefined
          ) {
            throw new EmbeddingsError(
              "embeddings response malformed: indices are not a permutation of the inputs",
            );
          }
          slots[at] = d;
        }
        ordered = slots;
      }
      return ordered.map((d, i) => {
        const v = d.embedding;
        if (!Array.isArray(v) || v.length === 0 || !v.every((n) => Number.isFinite(n))) {
          throw new EmbeddingsError(
            `embeddings response malformed: vector ${i} is not an array of numbers`,
          );
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
 * The `Memory` facade plus the providers behind it. `Memory` keeps them private and exposes only
 * the lowest common denominator, so the routes hold the providers too — to reach the optional
 * capabilities (`isPageable`, `isRecentListable`) a particular backend may offer. Typed as the
 * interfaces, not the SQLite classes: nothing here depends on which backend it is.
 */
export interface MemoryStore {
  memory: Memory;
  /** The working-memory provider behind `memory.workingMemory`, for the optional paging capability. */
  working: IWorkingMemoryProvider;
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
  return { memory, working, semantic };
}

/**
 * `undefined` = not initialised yet. `{ store: undefined }` = initialised, and memory is
 * disabled. Kept as one value because the two facts are one fact: "initialised" is only ever
 * true together with whatever `store` is, and two variables to keep in step is how a bad config
 * once became a permanent, silent "disabled" (see `initMemory`).
 */
let state: { store: MemoryStore | undefined } | undefined;

/**
 * Open the memory store. Called once at boot by `server.ts` so a bad path or an unloadable
 * database stops the daemon with a clear error, rather than surfacing on the first agent spawn
 * minutes later; `getMemoryStore()` also calls it lazily so tests and scripts need no ceremony.
 *
 * Nothing is recorded until there is an outcome to record, so a bad config (or an unopenable
 * database) throws on every call, and is never mistaken for "memory disabled".
 */
export function initMemory(): MemoryStore | undefined {
  if (state) return state.store;
  if (!MEMORY_ENABLED) {
    state = { store: undefined };
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
  const store = buildMemory({
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
  state = { store };
  log.info("memory ready", {
    path: MEMORY_DB_PATH,
    semantic: store.memory.hasSemanticMemory,
    maxFacts: MEMORY_MAX_FACTS || undefined,
    maxAgeMs: MEMORY_MAX_AGE_MS || undefined,
  });
  return store;
}

/** The daemon's shared memory store, or `undefined` when memory is disabled. */
export function getMemoryStore(): MemoryStore | undefined {
  return initMemory();
}

/**
 * `{ memory }` for an `Alineo` options object, or `{}` when memory is disabled (which leaves
 * `.memory` unset). Used only by `sdk.ts` — the one place alineod creates agents — so no call site
 * can forget it; `test/sdk-entrypoint.test.ts` holds that line.
 */
export function memoryOptions(): { memory?: Memory } {
  const store = getMemoryStore();
  return store ? { memory: store.memory } : {};
}

const utf8 = new TextEncoder();

/**
 * Compare two strings by their UTF-8 bytes — the order SQLite's BINARY collation gives, and so the
 * order every backend's working-memory pages are in. Not JavaScript's `<`, which compares UTF-16
 * code units and puts an astral character (U+1F600) before U+FFFF where bytes put it after.
 */
export function compareUtf8(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/**
 * The scope an agent's memory lives under — `Alineo.resourceRef`'s rule, via the shared
 * `resourceRefOf`. Read from the persisted spec rather than the
 * live `Alineo` handle so memory stays reachable after the agent ended, was lost, or alineod
 * restarted before it reconnected.
 */
export function agentResourceRef(specJson: string, fallbackName: string): ResourceRef {
  let spec: { name?: unknown; resourceId?: unknown; teamId?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(specJson);
    if (parsed && typeof parsed === "object") spec = parsed as typeof spec;
  } catch {
    /* fall back to the row's own name below */
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  // The rule itself — `resourceId ?? name`, plus `teamId` — is the SDK's, imported rather than
  // restated, so the two cannot drift. All that is done here is making the raw JSON safe to hand
  // it: the row's own name stands in for a spec too damaged to carry one.
  return resourceRefOf({
    name: str(spec.name) ?? fallbackName,
    resourceId: str(spec.resourceId),
    teamId: str(spec.teamId),
  });
}

/** Test seam: swap the shared store (or `undefined` to simulate disabled). @internal */
export function installMemoryForTests(store: MemoryStore | undefined): void {
  state = { store };
}

/** Test seam: forget the shared store so the next `getMemoryStore()` re-reads the config. @internal */
export function resetMemoryForTests(): void {
  state = undefined;
}
