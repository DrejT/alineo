---
"alineo": patch
---

`Alineo.load()` and `.spawn()` no longer leave a sandbox running when they fail partway: the sandbox is closed before the error is rethrown. A load whose cached snapshot restores but won't start (e.g. a snapshot taken on a runtime that didn't capture the container's filesystem) now discards that snapshot and rebuilds instead of failing.
