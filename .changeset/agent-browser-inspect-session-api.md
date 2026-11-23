---
"@alineo-labs/agent-browser": minor
---

Add `b.inspect({ mask })` (page structure, masked by default), `browserEnv()` + `b.setup()` (pinned user agent, viewport, locale, timezone, timeout, tab, input mode, blocked analytics hosts), `b.har.start/stop/summary` (find a site's endpoints without recording values), and `b.session.dump/save/load/request` (call a site's API with the browser's session, from a session file inside the sandbox, with no browser running). `saveSession`/`loadSession` are deprecated in favour of `b.session.save`/`b.session.load`.
