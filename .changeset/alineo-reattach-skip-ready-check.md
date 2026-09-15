---
"alineo": patch
---

`Alineo.reattach()` accepts `skipReadyCheck: true` to reconnect to a sandbox without probing its bridge, including a Paused one — for a paused sandbox, whose frozen bridge can't answer until it's resumed.
