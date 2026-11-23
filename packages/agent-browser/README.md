# @alineo-labs/agent-browser

Browser automation capability for `alineo` Pi sessions — a Pi extension wrapping the
[`agent-browser`](https://github.com/vercel-labs/agent-browser) CLI (accessibility-tree
snapshots with stable element refs, annotated screenshots — not coordinate-based targeting)
as five typed tool calls: `browser_open`, `browser_snapshot`, `browser_click`,
`browser_fill`, `browser_screenshot`.

```bash
bun add @alineo-labs/agent-browser
```

It has three parts:

- **A Pi extension** that gives an agent five browser tools (below).
- **Command builders** for a deterministic workflow that drives the browser with no LLM
  (`browser()`, `saveSession()`, `loadSession()`).
- **Host-side helpers**: `browserSetupSteps()` to install Chrome, and `enableBrowserStream()`
  for a live view.

## Deterministic workflows

`browser()` builds `agent-browser` commands for `@alineo-labs/workflow`'s `sb.exec()`. Every
command passes `--json`, and every argument is shell-quoted. Nothing in the package names a
site: URLs, selectors and the order of steps belong to the caller.

```ts
import { workflow } from "@alineo-labs/workflow";
import { browser, browserOk, browserSetupSteps, saveSession } from "@alineo-labs/agent-browser";

const b = browser();
const { vars } = await workflow(client)
  .sandbox({ image: "node:22-bookworm-slim", resources: { cpu: "2", memory: "2Gi" } }, (sb) => {
    for (const step of browserSetupSteps()) sb.exec(step.run);
    sb.exec(b.open("https://app.example.com/login"));
    sb.exec(b.fill("#username", "me@example.com"));
    sb.exec(b.fill("#password", "APP_PASSWORD")); // placeholder; see sb.setCredential
    sb.exec(b.click("#submit"));
    sb.exec(b.waitForUrl("**/dashboard", { timeoutMs: 15_000 }), {
      as: "login",
      parse: "json",
      strict: false,
    });
    saveSession(sb, "session"); // vars.session: the cookies and storage, as bytes
    sb.exec(b.download("#report", "/tmp/report.xlsx"));
    sb.readFileBytes("/tmp/report.xlsx", "report");
  })
  .result();

browserOk(vars.login); // true when the wait succeeded
```

A later run calls `b.session.load(sb, bytes)` before it opens the site, and skips the login
when a wait on a signed-in page succeeds. (`saveSession`/`loadSession` still work, and are
deprecated in favour of `b.session.save`/`b.session.load`.)

## Pinned environment

`browserEnv()` gives every run the same browser: a fixed user agent, a 1440×900 viewport,
`en-US`, `UTC`, a 30 s action timeout, `--pin-tab`, instant input, and the common analytics
and ad hosts blocked. Override any field. Run `b.setup()` once before the first real page.

```ts
const b = browser(browserEnv({ timezone: "Asia/Kolkata" }));
for (const c of b.setup()) sb.exec(c);
```

Google's own domains are not blocked by default: that would also block reCAPTCHA.

## Inspect a page without reading its data

`b.inspect()` returns the page's structure as JSON: links, buttons, inputs with their labels,
dialogs, iframes and counts. **Masking is on by default**: a label passes only when every word
in it is in the vocabulary (`DEFAULT_WORDS`, extend with `{ words }`), digits become `#`, ids
and UUIDs become `<id>`, input values, `data-*` and URL query strings are dropped, and table and
grid contents are not read (row counts only).

```ts
sb.exec(b.inspect({ words: ["dropship"] }), { as: "page", parse: "json", strict: false });
const page = parseInspect(vars.page);
```

`{ mask: false }` returns labels, values and full URLs as the page has them. Use it on a public
page or your own app only. Passwords are never returned either way. `inspectOnFailure(sb, b)`
queues a masked inspect after a failed `strict: false` step.

## Call a site's API with the browser's session

Use the browser to log in, then call the site's own API directly. Fewer steps, and no UI to
break. `b.session.dump(path)` writes the session to a file **inside the sandbox**, and
`b.session.request` reads it, so the cookies never leave the sandbox and no browser has to be
running for the call. With stored bytes, `sb.writeFileBytes(path, bytes)` replaces the dump.

```ts
sb.exec(b.session.dump("/tmp/s.json"));
b.session.request(
  sb,
  {
    method: "POST",
    url: "https://app.example.com/api/places",
    session: "/tmp/s.json",
    json: {},
    out: "/tmp/places.json",
  },
  { as: "places" },
);
b.session.request(
  sb,
  {
    method: "POST",
    url: "https://app.example.com/api/report/download",
    session: "/tmp/s.json",
    query: { from: "2026-10-01", to: "2026-10-31" },
    json: { ids: ref("/tmp/places.json", "data[].id") }, // read inside the sandbox
    out: "/tmp/report.xlsx",
    expect: { contentType: /spreadsheetml/, magic: "PK" },
    deleteSession: true,
  },
  { as: "download", strict: false },
);
```

- The request config travels in an env var, not in the command text the ledger records.
- `code: "auth_expired"` means a 401/403, an HTML page where `expect.contentType` wanted
  something else, or a redirect to another site: log in again.
- `ref(file, path)` reads a value from an earlier response inside the sandbox. `pick` returns
  values to the host instead.
- `headerFromStorage` takes a header (e.g. a bearer token) from saved localStorage.

### Find the endpoints once

Record a HAR after login (`--content none`: no response bodies), use the UI once, then
summarize it inside the sandbox. The summary has methods, paths, query names, body keys and
auth-like header names, and no values unless `{ mask: false }`. Delete the HAR after: request
bodies in it can hold real values.

```ts
sb.exec(b.har.start());
/* ...UI steps... */
sb.exec(b.har.stop("/tmp/x.har"));
sb.exec(b.har.summary("/tmp/x.har", { firstParty: ["example.com"] }), { as: "api", parse: "json" });
sb.deleteFile("/tmp/x.har");
```

**Session bytes are a credential.** A cookie for a signed-in account can skip the password and
any one-time code. Encrypt them before you store them. `saveSession` deletes the file from the
sandbox after it reads it.

**`browserSetupSteps()` pins agent-browser** to `AGENT_BROWSER_VERSION`, the last release this
package was verified against. Pass `browserSetupSteps({ version })` to try another one.

**Do not use agent-browser's `--allowed-domains` with sessions.** agent-browser rejects it
together with `--state` and `state load`. Restrict the sandbox with `networkPolicy` instead.

`tests/integration/workflow-browser-session.test.ts` and
`tests/integration/workflow-browser-determinism.test.ts` run these end to end against a local
fixture site: log in, save the session, then download a binary file from a fresh sandbox
without logging in.

---

## How it works

Two parts: `pi-extension/agent-browser.ts` is a Pi extension, not an importable library —
each tool's `execute()` runs `agent-browser <cmd> --json` via `pi.exec()`, which shells out
**locally, inside whatever sandbox this Pi session's own bridge process is already running
in** — not through `@alineo-labs/core`'s `SandboxHandle.exec()`. There is no `SandboxHandle` object to inject:
the `agent-browser` CLI's daemon, its authenticated session/profile state, and this
extension's own code all live in the same container already, the same way
`packages/cli/pi-extension/alineo.ts`'s tools shell out to `alineo` locally rather than
reaching back out to a host-side API.

`src/` is the complementary host-side library: `setup.ts`'s `browserSetupSteps()` returns
the `SetupStep[]` a spec splices into its own `setup` array to install Chrome and
`agent-browser` inside the sandbox before the extension above can use them, and
`stream.ts`'s `enableBrowserStream()`/`disableBrowserStream()` give a host-side caller (not
the agent itself) a proxied WebSocket URL to view the sandboxed browser live — going
through `@alineo-labs/core`'s `SandboxHandle.proxy()`, since that one does need a real `SandboxHandle` object.

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

The package ships `pi-extension/agent-browser.ts` as source. A spec's `setup` steps can
install the package and copy that file into the sandbox's Pi extensions folder, the way
`alineo.ts` is installed.

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
