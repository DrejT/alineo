---
"alineo": minor
"alineo-cli": patch
"alineo-mcp": patch
---

Config is now found, merged and validated in one place.

`alineo.config.json` is located by walking up from the working directory (bounded by a `.git`
directory, `$HOME`, or the filesystem root) instead of being read only from the exact working
directory. Running a script from a subdirectory previously fell back to built-in defaults in
silence, which looked identical to having no config at all.

Sources are merged lowest-first — `~/.config/alineo/config.json`, then `alineo.config.json`,
then `ALINEO_CONFIG_CONTENT` (inline JSON), then `ALINEO_SERVER_URL` / `ALINEO_API_KEY` /
`ALINEO_USE_SERVER_PROXY`, then explicit options — validated once, then frozen. A malformed file
or a bad value now fails with the offending key and file named, rather than being dropped.

`Alineo.load()`, `.resume()`, `.reattach()` and `.attach()` accept `opts.config` to skip file and
environment discovery entirely, for embedded callers and tests that must not depend on the
working directory. The config is also read once per working directory now, not on every call.

Three behaviour changes worth noting.

A project config found by walking up will now apply where defaults were previously used.

A global `~/.config/alineo/config.json` is merged under a project config instead of being ignored
whenever a project config exists. The SDK previously ignored the global config entirely while
`alineo-cli` already read it, so on a machine with a global config and no project config the two
disagreed about `adapterPath` — and therefore used different agent snapshot caches. They now
agree. If that describes your setup, the first `Alineo.load()` of each spec after upgrading
rebuilds its snapshot at the new location instead of reusing the old one; nothing is lost, but
expect one slow run per spec.

A spec that relied on the built-in `adapterPath`/`agentsDir` defaults while a global config set
different ones will now follow the global config. Pass `opts.config`, or set the value explicitly
in a project `alineo.config.json`, to pin it.
