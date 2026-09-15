---
"@alineo-labs/sandbox": patch
---

`client.connect()` accepts `allowPaused: true` to connect to a Paused sandbox. The handle comes back marked paused — `exec()` throws until `resume()`.
