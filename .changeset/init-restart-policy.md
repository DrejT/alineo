---
"alineo-cli": patch
"alineo-mcp": patch
---

`alineo init` now starts OpenSandbox and alineod with `--restart unless-stopped`, and sets that
policy on containers an earlier `init` created. Before, a reboot or a Docker daemon restart left
both down — OpenSandbox first, so nothing worked until `init` ran again, and alineod's crash
recovery never got the chance to run because nothing restarted alineod. `docker stop` still
sticks.
