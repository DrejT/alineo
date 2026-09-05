# @alineo-labs/vault

## 0.3.0

### Minor Changes

- 87a9c39: Credential injection: replace the placeholder `query` / `path` shapes with a working
  `substitution` type.

  `CredentialBinding.injection` (and `AgentSpec.env`'s `CredentialEnvBinding.injection`) is now:

  ```ts
  | { type: "header"; name: string }
  | { type: "substitution"; placeholder: string; in: Array<"path" | "query" | "header" | "body"> }
  ```

  `substitution` maps onto the egress sidecar's real `passthrough` + `substitutions` auth model:
  the sidecar replaces every literal occurrence of `placeholder` in the listed request surfaces
  with the credential value. **The outbound request must already contain `placeholder` verbatim**
  — put it in a base URL, e.g. `https://api.example.com/v1?key=__API_KEY__`. `header` injection
  is unchanged and stays the recommended default.

  **Migration** — the old `{ type: "query"; param }` / `{ type: "path"; segment }` shapes are
  removed (they only ever threw `UnsupportedInjectionError`). Replace
  `{ type: "query"; param: "k" }` with `{ type: "substitution"; placeholder: "__CRED__"; in: ["query"] }`
  and add `?k=__CRED__` to the request. `sb.credentials.listBindings()` is lossy for
  substitution bindings (the vault does not echo `substitutions` back) — `resume()` / `fork()`
  recover the full shape from the ledger instead.

### Patch Changes

- Updated dependencies [87a9c39]
- Updated dependencies [87a9c39]
- Updated dependencies [c4e64df]
  - @alineo-labs/core@0.4.0
  - @alineo-labs/opensandbox@0.3.0

## 0.2.0

### Minor Changes

- f987d00: Credential injection: sandboxes can now register credentials that get injected into outbound
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

### Patch Changes

- Updated dependencies [f987d00]
- Updated dependencies [223390e]
- Updated dependencies [84b7862]
  - @alineo-labs/core@0.3.0
  - @alineo-labs/opensandbox@0.2.0
