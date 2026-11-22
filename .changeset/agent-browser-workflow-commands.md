---
"@alineo-labs/agent-browser": minor
---

Publish the package to npm. Add `browser()` command builders for deterministic workflows, `browserOk`/`parseBrowserResult` for agent-browser's `--json` envelope, and `saveSession`/`loadSession` to move a signed-in browser session between sandboxes as bytes.

`browserSetupSteps()` now pins agent-browser (`AGENT_BROWSER_VERSION`, default `0.43.0`; override with `{ version }`), and no longer runs `agent-browser install --with-deps` next to its own `apt-get`. Current agent-browser runs `apt-get` itself for `--with-deps`, and the two failed on the dpkg lock.
