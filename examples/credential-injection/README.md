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

## Notes

All examples default to `useServerProxy: true` — traffic routes through the OpenSandbox server so
Docker bridge IPs don't need to be reachable directly. Set `USE_SERVER_PROXY=false` to disable
(e.g. when using `uvx opensandbox-server` on the host).

This example has **not been run against a live server** — see plans/credential-injection.md for
the open caveats (vault request/response schema and the egress sidecar's management port are
sourced from OpenSandbox's own docs, not yet independently verified).
