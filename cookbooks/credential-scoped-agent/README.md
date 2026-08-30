# credential-scoped-agent

An agent that does real work against an authenticated API — GitHub, here — using a token it
can never read. The token is registered as a **credential**, not an environment variable: it's
injected into matching outbound requests at the egress layer, so the agent can call
`api.github.com` as you while the value itself never enters the container's filesystem or
environment. Revoking it takes effect immediately, mid-session, without touching the running
sandbox.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
export NVIDIA_API_KEY=...   # the agent's model key — https://build.nvidia.com, free tier
export GH_TOKEN=...         # a GitHub PAT (classic or fine-grained); read-only scopes are enough
```

`GH_TOKEN` is just the raw token — the agent spec (`agents/github-agent.json`) wraps it as
`Bearer ${GH_TOKEN}` so the injected `Authorization` header is well-formed for GitHub.

Credential injection rides on the same egress layer as network policy, so the server needs
`egress.image` configured and `egress.mode = "dns+nft"` — the default for `alineo init` since
this feature landed. On an older local config, add:

```toml
[egress]
image = "opensandbox/egress:v1.1.7"
mode = "dns+nft"
```

to `~/.config/alineo/server.toml` and restart the server.

## Run

```bash
bun install
bun start
```

## What it does

1. **`Alineo.load()` reads `agents/github-agent.json`**, whose `env.GITHUB_TOKEN` is a
   `{ credential, host, injection }` binding rather than a string. Because at least one binding
   is present, `load()` creates the sandbox with `credentialProxy: true` and registers the
   token with the egress sidecar's Credential Vault — it never becomes a container env var.
   `env.NVIDIA_API_KEY`, an ordinary string, is exported the normal way.
2. **The agent does authenticated GitHub work** — prompted to identify the token's account and
   list its recently pushed repos, it writes and runs its own `curl … | jq …` against
   `api.github.com`. The requests come back authenticated.
3. **Audit** — `env | grep` inside the sandbox turns up nothing, and a bare
   `curl https://api.github.com/user` with no `Authorization` header of its own still returns
   `HTTP 200`: the credential reached the request at the sidecar, not through anything the
   agent could see.
4. **Revoke** — `agent.sandbox.credentials.remove("GITHUB_TOKEN")`, and the same bare request
   now returns `HTTP 401`. The agent, asked to retry, reports the 401 itself.

## The point

`AgentSpec.env` is the obvious place to hand an agent a secret, but a plain env var is readable
by anything running in the sandbox — including code the agent wrote itself, and including a
prompt-injected instruction to print it. A credential binding gives the agent the _capability_
(authenticated calls to one host) without the _secret_, and leaves you holding the leash: one
`remove()` call cuts access at the network layer, with no redeploy and nothing to clean up
inside the container.

## Where to go next

- [`examples/credential-injection`](https://github.com/DrejT/alineo/tree/main/examples/credential-injection)
  — the same mechanism at the raw `Sandbox` level (no agent), plus `fork()` carrying a bound
  credential to the child automatically and the `source` / `resolveCredential` contract for
  `resume()`.
- [Credentials](https://docs.alineo.tech/docs/core/0.2/concepts/credentials) in the docs for
  the full `sb.credentials.*` API, `pathPrefix` scoping, and how bindings behave across
  `resume()` / `fork()` / spawned children.

## Notes

The binding here uses `credential: "Bearer ${GH_TOKEN}"`, an interpolated string rather than a
bare `${GH_TOKEN}` — so its `CredentialSource` is `{ type: "external" }`, not `{ type: "env" }`.
That only matters for `resume()` / `fork()` (which would then need an explicit
`resolveCredential` callback); this recipe loads the agent, uses it, and closes it, so it never
comes up. Use a bare `${GH_TOKEN}` (and a token that already includes its scheme) if you want
env-based auto-resolution.

Header injection is currently the only supported `injection` type — `query` and `path` bindings
are defined in the types but not yet wired to the sidecar's auth model.
