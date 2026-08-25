---
"@alineo-labs/vault": minor
"@alineo-labs/core": minor
"@alineo-labs/opensandbox": minor
"@alineo-labs/sandbox": minor
"alineo": minor
"alineo-cli": patch
---

Credential injection: sandboxes can now register credentials that get injected into outbound
requests via OpenSandbox's Credential Vault, without the sandbox process ever holding the real
value.

- New `@alineo-labs/vault` package — `OpenSandboxCredentialBroker`, the default `CredentialBroker`
  implementation, wired up automatically by `@alineo-labs/sandbox` unless overridden.
- `@alineo-labs/core`: new `CredentialBroker`/`CredentialBinding`/`CredentialSource` interfaces
  (mirrors `IStorageAdapter`'s shape), `sb.credentials.set()/patch()/remove()/listBindings()` on
  `SandboxHandle`, `SandboxHooks.onCredentialInjected`, and two new `LedgerEvent`s
  (`CredentialBound`/`CredentialRevoked`, binding metadata only — never the credential value).
  `CredentialSource` (`{ type: "env", varName }` vs. `{ type: "external" }`) lets `resume()` and
  `sb.fork()` resolve env-backed credentials automatically; anything else requires an explicit
  `resolveCredential` callback, and both now **throw** rather than silently drop a bound
  credential if one isn't resolvable.
- `@alineo-labs/opensandbox`: `NetworkPolicy`/`NetworkRule`/`CredentialProxyConfig` types, and
  `networkPolicy`/`credentialProxy` on `CreateSandboxOptions`.
- `@alineo-labs/sandbox`: `SandboxOptions.networkPolicy`/`credentialProxy`,
  `SandboxClientOptions.credentialBroker`, and `ResumeOptions.resolveCredential`. `sb.fork()`
  now also carries over the parent's own bound credentials to the child automatically (previously
  silently dropped), and takes an optional `{ resolveCredential, credentialProxy }`.
- `alineo` (agent package): `AgentSpec.env` values can now be a `CredentialEnvBinding`
  (`{ credential, host, injection }`) instead of a plain string — that key never becomes a
  container env var at all; `Alineo.load()`/`.resume()`/`.spawn()` register it with the broker
  instead (including for a spawned child's own newly-declared bindings, previously dropped).
- `alineo-cli`: `alineo init` now configures `[egress]` (`opensandbox/egress:v1.1.7`,
  `mode = "dns+nft"`) in the generated local server config by default — inert for any sandbox
  that doesn't request `networkPolicy`, but required before `credentialProxy: true` works at all
  against a fresh `alineo init` server.

See `plans/credential-injection.md` for the full design (issue #203). Verified end-to-end against
a live `opensandbox/server:latest` + `opensandbox/egress:v1.1.7`: registration, transparent
injection, revocation, and `fork()` credential carrying. Two known limitations, both from the
real Credential Vault API rather than this package: only `{ type: "header" }` credential bindings
are supported for now (`query`/`path` injection has no direct equivalent in the sidecar's `Auth`
model), and `OpenSandboxCredentialBroker.patch()` requires both `value` and `binding` together
(the vault never echoes a credential's value back, so a partial update can't preserve the
unspecified half).
