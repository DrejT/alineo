# Provider contract tests

What a sandbox provider must do for alineo to run on it.

The suite goes through the public SDK (`Sandbox`, `SandboxHandle`), not a provider's client, so
the same domains stay valid when the provider underneath changes. A provider is bound to the suite
by one small file that builds a `ProviderBinding`. `opensandbox.contract.test.ts` is the template.

## Domains

| Domain      | What it asserts                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `lifecycle` | create, list, close, the ledger records the provider, a bad image fails typed and does not hang             |
| `exec`      | stdout, stderr, exit code, `COMMAND_FAILED`, cwd and env, streaming order, newlines, stdin, timeout         |
| `files`     | text, binary, 5 MB round trip, a file written by a command is readable through the file API                 |
| `snapshot`  | a fork keeps a file written to each of nine paths, a fork is independent, the parent keeps running          |
| `endpoint`  | an HTTP server inside the sandbox is reachable, an SSE stream survives a silent gap (the Pi bridge's shape) |

`snapshot` and `endpoint` run only when the binding claims them. A provider is never tested for
something it does not claim.

## Run

```bash
# against a server on :8080 (alineo init, or uvx opensandbox-server)
bun run test:contract

OPEN_SANDBOX_URL=http://127.0.0.1:8090 bun run test:contract    # another server
OPEN_SANDBOX_SERVER_PROXY=false bun run test:contract           # bare uvx server
OPEN_SANDBOX_RUNTIME=gvisor bun run test:contract               # /tmp is a known snapshot loss
CONTRACT_SSE_IDLE_SECONDS=30 bun run test:contract              # longer silent gap
```

It creates and closes real sandboxes. It takes about a minute.

## Adding a provider

1. Copy `opensandbox.contract.test.ts` and build a `ProviderBinding` for the provider.
2. Set `capabilities` to what the provider claims. Claim nothing it does not do.
3. List known snapshot losses in `snapshotKnownLosses`. A listed path that is not lost fails the
   test, so the list cannot go stale.
4. Run it. A failure is a defect in the provider, in alineo, or in a capability claim.

## What it has found

- `execd v1.0.22` emits one stdout event per line **without the newline**, so `echo one; echo two`
  returned `"onetwo"`. `release-1.1.1` keeps the newline (OpenSandbox 380322ba). `alineo init`
  pinned `v1.0.22`. Fixed twice: the pin moved to `release-1.1.1`, and `ExecHandle` restores the
  endings for installs that kept the old pin. The suite passes on both execd versions.
