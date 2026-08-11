# @drej/agent-browser

Browser automation capability for `@drej/agent` Pi sessions — a Pi extension wrapping the
[`agent-browser`](https://github.com/vercel-labs/agent-browser) CLI (accessibility-tree
snapshots with stable element refs, annotated screenshots — not coordinate-based targeting)
as five typed tool calls: `browser_open`, `browser_snapshot`, `browser_click`,
`browser_fill`, `browser_screenshot`.

Private package — not published to npm.

---

## How it works

Two parts: `pi-extension/agent-browser.ts` is a Pi extension, not an importable library —
each tool's `execute()` runs `agent-browser <cmd> --json` via `pi.exec()`, which shells out
**locally, inside whatever sandbox this Pi session's own bridge process is already running
in** — not through `@drej/core`'s `Sandbox.exec()`. There is no `Sandbox` object to inject:
the `agent-browser` CLI's daemon, its authenticated session/profile state, and this
extension's own code all live in the same container already, the same way
`packages/cli/pi-extension/drejx.ts`'s tools shell out to `drejx` locally rather than
reaching back out to a host-side API.

`src/` is the complementary host-side library: `setup.ts`'s `browserSetupSteps()` returns
the `SetupStep[]` a spec splices into its own `setup` array to install Chrome and
`agent-browser` inside the sandbox before the extension above can use them, and
`stream.ts`'s `enableBrowserStream()`/`disableBrowserStream()` give a host-side caller (not
the agent itself) a proxied WebSocket URL to view the sandboxed browser live — going
through `@drej/core`'s `Sandbox.proxy()`, since that one does need a real `Sandbox` object.

`agent-browser` itself needs to be installed in the sandbox via a spec's `setup` steps:

```bash
npm install -g agent-browser
agent-browser install --with-deps
```

> **Gotcha, verified against a live OpenSandbox sandbox**: `agent-browser install
--with-deps` shells out via `sudo` to install Chrome's system libraries — but OpenSandbox
> containers run as root with no `sudo` binary at all, so that step fails silently (Chrome
> still "installs" since downloading/extracting it doesn't need `sudo`) and the browser then
> can't launch (`error while loading shared libraries: libnspr4.so: ...`, then `libatk-1.0.so.0`,
> etc. — one missing lib at a time as each gets fixed). Work around it by installing the same
> package list directly (no `sudo`) _before_ running `agent-browser install --with-deps`:
> `apt-get update && apt-get install -y libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6
libxrandr2 libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libgtk-3-0
libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 libcairo-gobject2 libcairo2
libgdk-pixbuf-2.0-0 libxrender1 libasound2 libfreetype6 libfontconfig1 libdbus-1-3 libnss3
libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 libxshmfence1
libgbm1 fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf` — `browserSetupSteps()`
> in `src/setup.ts` already runs both legs concurrently to work around this; use it rather
> than reproducing the install steps by hand.

Wiring the extension itself into a sandbox depends on how the package is distributed. A
package published to npm can `cp` its extension file the way `drejx.ts` does; since
`@drej/agent-browser` isn't published, a spec's own `setup` steps need to push
`pi-extension/agent-browser.ts`'s source into the sandbox directly instead (no worked
example ships in this repo yet).

### Tools

| Tool                 | Wraps                                                   | Notes                                                                                                                     |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `browser_open`       | `agent-browser open [url]`                              | No `url` just launches the browser.                                                                                       |
| `browser_snapshot`   | `agent-browser snapshot`                                | Returns refs (`@e1`, ...) for interactive elements. Refs go stale on page change — always re-snapshot before reusing one. |
| `browser_click`      | `agent-browser click <ref>`                             | Takes a ref from the most recent snapshot.                                                                                |
| `browser_fill`       | `agent-browser fill <ref> <text>`                       | Clears and types.                                                                                                         |
| `browser_screenshot` | `agent-browser screenshot <path> [--annotate] [--full]` | Returns the PNG as image content directly in the tool result, in addition to any stdout.                                  |

---

## Known limitations (not handled)

These are deliberately unbuilt, not just deprioritized — there is no fallback behavior for
either case. A task that hits one of these fails like any other unresolvable step, rather
than degrading gracefully.

- **CAPTCHA handling.** Neither text/image CAPTCHAs nor interactive ones (drag-slider,
  click-all-matching-tiles) have any special handling.
- **Verify/first-run UX.** There is no live view of the sandboxed browser during a login or
  first run. The only visibility into what happened is post-hoc — the transcript and
  screenshots already captured in the agent's trace, read after the run completes.

---

## License

Apache 2.0
