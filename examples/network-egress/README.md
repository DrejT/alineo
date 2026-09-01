# network-egress

A deny-by-default sandbox whose outbound allow-list is changed at runtime with `sb.egress.*`.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
```

Requires a server with `egress.image` configured and `egress.mode = "dns+nft"` — the default for
`alineo init`. On an older config or the `uvx opensandbox-server` setup, add:

```toml
[egress]
image = "opensandbox/egress:v1.1.7"
mode = "dns+nft"
```

to `~/.config/alineo/server.toml` (Docker) or `~/.sandbox.toml` (uvx), then restart the server.

## Run

```bash
bun install
bun start
```

## What it does

1. Creates a sandbox with `networkPolicy: { defaultAction: "deny", egress: [] }` — an egress
   sidecar that lets nothing out.
2. `sb.egress.patch([{ action: "allow", target: "example.com" }])` — allows one host on the
   already-running sandbox; the change hits the sidecar immediately.
3. Shows a CIDR target being accepted. IP/CIDR rules are enforced at the nftables layer (so
   they need `dns+nft` mode) and gate raw-IP egress — they do **not** authorize resolving a
   *domain* into that range, so for reach-by-name you still want a domain rule.
4. `sb.egress.delete(["example.com"])` — revokes it; the host is blocked again.
5. `sb.egress.get()` — reads back the live policy from the sidecar.

Reachability is probed with `getent hosts <name>` — it exits 0 only when the egress policy
lets the DNS query through.

Every `patch` / `delete` is recorded to the ledger (`EgressRuleAdded` / `EgressRuleRemoved`),
so `Sandbox.resume()` folds whatever is still live back into the resumed sandbox's boot policy
— egress policy is sidecar-local and does not survive a resume on its own.

## Notes

All examples default to `useServerProxy: true` — traffic routes through the OpenSandbox server so
Docker bridge IPs don't need to be reachable directly. Set `USE_SERVER_PROXY=false` to disable
(e.g. when using `uvx opensandbox-server` on the host).
