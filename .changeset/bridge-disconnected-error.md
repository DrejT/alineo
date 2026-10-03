---
"alineo": minor
---

New `BridgeDisconnectedError`, thrown by a `prompt()`/`bash()` stream when the underlying
connection closes without the bridge's own `[DONE]` sentinel ever arriving — the bridge process
died mid-stream, not Pi genuinely finishing the turn. Previously this looked identical to a
clean finish at the stream level (a raw TCP EOF and an application-level `[DONE]` both just end
the generator with no error), so a crashed bridge's partial turn could be silently recorded as a
successful one with whatever text happened to be read back. Verified live on `my-vps`
(durability-roadmap M2.1 follow-up, 2026-10-03): `kill -9`ing the bridge process mid-tool-call
settled the turn as a false `success` with no text, in under 20 seconds.
