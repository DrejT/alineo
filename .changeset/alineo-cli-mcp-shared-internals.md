---
"alineo-cli": patch
"alineo-mcp": patch
---

No behavior change: `alineo init`'s Docker orchestration, `alineo.config.json`/`server.toml` handling, and the Pi provider API key list were hand-copied between `alineo-cli` and `alineo-mcp` (justified at the time by `alineo-cli` only publishing its `bin`, not these internals as a library entry point) and had already drifted — the `alineo-mcp` copy was missing rationale comments the `alineo-cli` copy had, with no shared import or test to signal when one needed the same fix as the other. Both are now generated from one internal `@alineo-labs/cli-shared` module (private, never published — bundled into each consumer's own `dist` at build time), so `alineo init` and the `alineo_init` MCP tool can no longer silently diverge.
