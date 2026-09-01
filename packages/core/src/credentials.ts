import { SandboxError } from "./errors";
import { LedgerEvent } from "./ledger";
import type { LedgerEntry } from "./ledger";

/**
 * How a credential reaches an outbound request.
 *
 * - `header` — the sidecar adds the header `name: <value>` (value unprefixed; use it for
 *   `Authorization`, `X-API-Key`, etc.). The common case.
 * - `substitution` — the sidecar replaces every literal occurrence of `placeholder` in the
 *   listed request surfaces with the value. **The request must already contain `placeholder`
 *   verbatim** — the agent or its config puts it there (e.g. a base URL of
 *   `https://api.example.com/v1?key=__API_KEY__`). This is the escape hatch for APIs that
 *   only take a key in the URL; `path`/`query` values are URL-encoded, `body` is encoded per
 *   content-type.
 */
export type CredentialInjection =
  | { type: "header"; name: string }
  | {
      type: "substitution";
      placeholder: string;
      in: Array<"path" | "query" | "header" | "body">;
    };

/**
 * Where and how a credential is injected into outbound requests. Matched by `host` (an FQDN
 * or wildcard domain, e.g. `"api.github.com"` or `"*.openai.com"`) and, optionally, a
 * `pathPrefix` to further scope the binding within that host.
 */
export interface CredentialBinding {
  /** FQDN or wildcard domain this credential applies to. */
  host: string;
  /** Narrows the binding to requests whose path starts with this prefix. */
  pathPrefix?: string;
  /** How the credential reaches the request. */
  injection: CredentialInjection;
}

/**
 * Where a credential's *value* comes from — orthogonal to `CredentialBinding` (which only
 * describes where it gets injected). Persisted in the ledger alongside the binding (metadata
 * only, never the value itself) so `resume()`/`fork()` know how to re-supply it later.
 *
 * `"env"` resolves automatically from `process.env` — no caller code needed. `"external"`
 * means the value isn't re-derivable from anything alineo can see on its own (a one-time
 * minted token, a value generated at call time, ...) — resolving one requires an explicit
 * `CredentialResolver` at resume/fork time, and `resolveBoundCredential()` throws rather than
 * silently proceeding if one isn't supplied.
 */
export type CredentialSource =
  | { type: "env"; varName: string }
  | { type: "external"; ref?: string };

/**
 * Persistence-agnostic contract for registering credentials that get injected into a sandbox's
 * outbound requests without the sandbox process ever holding the real value — mirrors
 * `IStorageAdapter`'s shape. `alineo` ships `OpenSandboxCredentialBroker` (from
 * `@alineo-labs/vault`) as the default/only implementation today.
 *
 * Implementations must never surface the raw `value` passed to `set()`/`patch()` back out of
 * any other method — `listBindings()` in particular returns binding *shape* only, so callers
 * (e.g. `Sandbox.resume()`) can know what to re-register without alineo itself ever needing to
 * persist a secret.
 */
export interface CredentialBroker {
  /** Register (or replace) a named credential's value and where it gets injected. */
  set(sandboxId: string, name: string, value: string, binding: CredentialBinding): Promise<void>;
  /** Update a binding's injection rule and/or value without needing to resupply both. */
  patch(
    sandboxId: string,
    name: string,
    changes: Partial<{ value: string; binding: CredentialBinding }>,
  ): Promise<void>;
  /** Revoke a credential — subsequent matching requests are no longer injected. */
  remove(sandboxId: string, name: string): Promise<void>;
  /** List binding metadata (host/injection shape) for a sandbox — never returns values. */
  listBindings(sandboxId: string): Promise<Array<{ name: string; binding: CredentialBinding }>>;
}

/** Resolves a bound credential's real value, given its name and `CredentialSource`, at resume/fork time. */
export type CredentialResolver = (
  name: string,
  source: CredentialSource,
) => string | undefined | Promise<string | undefined>;

/**
 * Resolves a bound credential's value: `type: "env"` sources resolve automatically from
 * `process.env`; anything else — or an env var that's since become unset — falls back to the
 * caller-supplied `resolver`. Throws `SandboxError` if neither yields a value, rather than
 * silently dropping the credential (the previous behavior when no resolver was supplied at
 * all — see plans/credential-injection.md).
 */
export async function resolveBoundCredential(
  name: string,
  source: CredentialSource | undefined,
  resolver: CredentialResolver | undefined,
  sandboxId: string,
): Promise<string> {
  if (source?.type === "env") {
    const fromEnv = process.env[source.varName];
    if (fromEnv !== undefined) return fromEnv;
  }
  const fromResolver = await resolver?.(name, source ?? { type: "external" });
  if (fromResolver !== undefined) return fromResolver;
  throw new SandboxError(
    `Cannot resolve credential "${name}" for sandbox ${sandboxId}` +
      (source?.type === "env"
        ? ` (env var "${source.varName}" is not set)`
        : ` (source: ${source?.type ?? "unknown"})`) +
      ` — pass a resolveCredential callback that returns a value for it.`,
    sandboxId,
  );
}

/** One credential's reconstructed state, as recovered from ledger history by `reconstructBoundCredentials()`. */
export interface BoundCredential {
  binding: CredentialBinding;
  source?: CredentialSource;
}

/**
 * Reconstructs the latest bound/revoked state per credential name from a session's ledger
 * history — used by both `Sandbox.resume()` and `sb.fork()` to know what to re-register on a
 * new sandbox, since the vault itself (sidecar-runtime-only state) never survives either
 * operation. Scans the *whole* history, not just some replay window — credential bindings
 * aren't tied to specific execs the way exec replay is.
 */
export function reconstructBoundCredentials(entries: LedgerEntry[]): Map<string, BoundCredential> {
  const result = new Map<string, BoundCredential>();
  for (const entry of entries) {
    if (entry.event === LedgerEvent.CredentialBound) {
      const { name, binding, source } = entry.payload as {
        name: string;
        binding: CredentialBinding;
        source?: CredentialSource;
      };
      result.set(name, { binding, source });
    } else if (entry.event === LedgerEvent.CredentialRevoked) {
      const { name } = entry.payload as { name: string };
      result.delete(name);
    }
  }
  return result;
}
