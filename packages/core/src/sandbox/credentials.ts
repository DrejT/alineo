import { SandboxError } from "../errors";
import { LedgerEvent } from "../ledger";
import type { CredentialBinding, CredentialSource } from "../credentials";
import type { SandboxInternal } from "./internal";

function requireBroker(sb: SandboxInternal) {
  const broker = sb.deps.credentialBroker;
  if (!broker) {
    throw new SandboxError(
      "No CredentialBroker configured — pass credentialProxy: true to client.sandbox() " +
        "(and ensure the OpenSandbox server has egress.image configured) to use sb.credentials.*",
      sb.sandboxId,
    );
  }
  return broker;
}

/**
 * Register (or replace) a named credential's value and where it gets injected.
 *
 * @param source  Where `value` came from — `{ type: "env", varName }` resolves automatically
 *   on `resume()`/`fork()`; anything else (including omitting this) requires an explicit
 *   `resolveCredential` callback there, and `resume()`/`fork()` throw rather than silently
 *   dropping the credential if one isn't supplied. Persisted as metadata only — never `value`.
 */
export async function set(
  sb: SandboxInternal,
  name: string,
  value: string,
  binding: CredentialBinding,
  source?: CredentialSource,
): Promise<void> {
  const broker = requireBroker(sb);
  await broker.set(sb.sandboxId, name, value, binding);
  // Full binding shape (host/pathPrefix/injection) plus source is metadata, never the value —
  // safe to persist as-is, and needed in full so Sandbox.resume()/sb.fork() can reconstruct it
  // without the caller having to keep a separate copy of every binding definition.
  await sb.emit(LedgerEvent.CredentialBound, -1, { name, binding, source });
  sb.deps.hooks?.onCredentialInjected?.(sb.sandboxId, name, binding);
}

/**
 * Update a binding's injection rule, source, and/or value without needing to resupply all
 * three. Note: a ledger entry (needed for `resume()`/`fork()` reconstruction) is only written
 * when `changes.binding` is provided — this module doesn't track prior state to merge a
 * source-only change against, so changing `source` alone requires re-passing the (possibly
 * unchanged) `binding` too.
 */
export async function patch(
  sb: SandboxInternal,
  name: string,
  changes: Partial<{ value: string; binding: CredentialBinding; source: CredentialSource }>,
): Promise<void> {
  const broker = requireBroker(sb);
  await broker.patch(sb.sandboxId, name, { value: changes.value, binding: changes.binding });
  if (changes.binding) {
    await sb.emit(LedgerEvent.CredentialBound, -1, {
      name,
      binding: changes.binding,
      source: changes.source,
    });
    sb.deps.hooks?.onCredentialInjected?.(sb.sandboxId, name, changes.binding);
  }
}

/** Revoke a credential — subsequent matching requests are no longer injected. */
export async function remove(sb: SandboxInternal, name: string): Promise<void> {
  const broker = requireBroker(sb);
  await broker.remove(sb.sandboxId, name);
  await sb.emit(LedgerEvent.CredentialRevoked, -1, { name });
}

/** List binding metadata (host/injection shape) for this sandbox — never returns values. */
export async function listBindings(
  sb: SandboxInternal,
): Promise<Array<{ name: string; binding: CredentialBinding }>> {
  const broker = requireBroker(sb);
  return broker.listBindings(sb.sandboxId);
}
