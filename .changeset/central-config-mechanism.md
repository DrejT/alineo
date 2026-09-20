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

Two behaviour changes worth noting: a project config found by walking up will now apply where
defaults were previously used, and a global `~/.config/alineo/config.json` is merged under a
project config instead of being ignored whenever a project config exists.
