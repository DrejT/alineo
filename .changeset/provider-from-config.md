---
"@alineo-labs/sandbox": patch
"@alineo-labs/schema": patch
"alineo": patch
"alineo-cli": patch
---

Pick the sandbox provider from `alineo.config.json`, in the CLI and in alineod.

- `alineo.config.json` gains `provider`. It defaults to `"opensandbox"`, which is the only
  provider today, so a file without the key behaves as before. `ALINEO_PROVIDER` overrides it.
  `alineo init` writes the key into a new file and never rewrites an existing one.
- `@alineo-labs/sandbox` exports `providerFromConfig()` and `clientFromConfig()`. An unknown id
  throws `INVALID_ARGUMENT` and names the known ids.
- Every CLI command and the agent runtime build their client through `clientFromConfig()`, so no
  call site names OpenSandbox.
- A provider that declares it cannot enforce egress is refused before the approval listener
  starts, with `CAPABILITY_UNSUPPORTED`.
- The leak check (`apps/alineod/scripts/sandbox-leaks.ts`) lists and deletes sandboxes through
  the provider instead of calling the OpenSandbox REST API.
