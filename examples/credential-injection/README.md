# credential-injection

Registers a credential with a sandbox and shows it get injected into matching outbound requests
transparently — the sandbox process never holds the real value.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
```

Requires a server with `egress.image` configured and `egress.mode = "dns+nft"` — the default for
`alineo init` as of this feature landing. If you're on an older local config or the manual `uvx
opensandbox-server` setup, add:

```toml
[egress]
image = "opensandbox/egress:v1.1.7"
mode = "dns+nft"
```

to `~/.config/alineo/server.toml` (Docker path) or `~/.sandbox.toml` (uvx path), then restart the
server.

## Run

```bash
bun install
bun start
```

Optionally set `GH_TOKEN` to a real GitHub token first for a real `HTTP 200` instead of `401`:

```bash
GH_TOKEN=ghp_xxx bun start
```

## What it does

1. Creates a sandbox with `networkPolicy` + `credentialProxy: true`, which attaches an egress
   sidecar.
2. Registers a `"github"` credential via `sb.credentials.set()`, bound to `api.github.com` with
   header injection — tagged with `source: { type: "env", varName: "GH_TOKEN" }` so it could be
   auto-resolved again later by `resume()`/`fork()` without a callback.
3. Runs `env | grep -i github` inside the sandbox to show the token isn't there — then a `curl`
   to `api.github.com` with no `Authorization` header of its own, to show the sidecar added it
   anyway.
4. Forks the sandbox and repeats the same request from the child — the bound credential carries
   over automatically, no re-registration needed.
5. Calls `sb.credentials.remove()` and repeats the request once more, now unauthenticated.
6. Registers a second credential with `injection: { type: "substitution", placeholder, in }` and
   shows a placeholder in the request URL (`?api_key=__TOKEN__`) get swapped for the real value
   at the sidecar — for APIs that take a key in the query string rather than a header.

## Notes

All examples default to `useServerProxy: true` — traffic routes through the OpenSandbox server so
Docker bridge IPs don't need to be reachable directly. Set `USE_SERVER_PROXY=false` to disable
(e.g. when using `uvx opensandbox-server` on the host).

Verified end-to-end against a live `opensandbox/server:latest` + `opensandbox/egress:v1.1.7`
(Docker runtime): registration, transparent injection, revocation, and `fork()` credential
carrying all work as described above. `@alineo-labs/vault`'s wire protocol was corrected against
OpenSandbox's actual Go source (`components/egress/pkg/credentialvault`) during that
verification — see plans/credential-injection.md's addendum for what changed and why.

Two `injection` types are supported: `{ type: "header", name }` and
`{ type: "substitution", placeholder, in }` (the sidecar swaps a literal placeholder the
request already contains — in the path, query, a header, or the body — for the value; use it
for APIs that take a key in the URL). `sb.credentials.listBindings()` is lossy for substitution
bindings (the vault doesn't echo the placeholder back) — `resume()`/`fork()` recover the full
shape from the ledger.

One known limitation from the real Credential Vault API: `OpenSandboxCredentialBroker.patch()`
requires both `value` and `binding` together — the vault never echoes a credential's value
back, so a partial update can't preserve the unspecified half.
