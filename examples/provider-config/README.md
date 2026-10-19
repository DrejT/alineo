# provider-config

Choose the sandbox provider from config: build it, read what it can do, see an unknown id refused, see the ledger record the owner, and see a missing capability refused before any container exists.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
```

## Run

```bash
bun install
bun start
```

## What it does

Builds the provider a config names with `providerFromConfig()`, runs a sandbox through `clientFromConfig()`, reads the owner from the ledger, and wraps the provider so it declares `egress: false` to show `CAPABILITY_UNSUPPORTED`.

## Notes

All examples default to `useServerProxy: true` — traffic routes through the OpenSandbox server so
Docker bridge IPs don't need to be reachable directly. Set `USE_SERVER_PROXY=false` to disable
(e.g. when using `uvx opensandbox-server` on the host).
