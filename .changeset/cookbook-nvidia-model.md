---
---

Cookbooks only, no publishable package changes: point the three agent recipes at a live
NVIDIA NIM model.

`ai-agent-bugfix`, `persistent-agent-memory` and `credential-scoped-agent` pinned
`nvidia/nemotron-3-nano-30b-a3b`, which reached end-of-life on the NVIDIA NIM API on
2026-09-01 — `/v1/chat/completions` now returns `410 Gone`. The agent's completion call
failed silently (empty event stream) and each recipe still exited 0 while doing nothing.

Swapped all three specs to **`nvidia/nemotron-3.5-lightning-30b-a3b`** (same 30B-a3b class,
still on the free tier). Verified end-to-end against a local OpenSandbox server: the bugfix
agent diagnoses and fixes the off-by-one and passes independent verification; the memory
agent recalls the customer profile across sandbox sessions and answers grounded in it; the
credential agent runs its own authenticated `curl` and the inject/revoke audit behaves.

`examples/*` and `packages/model-providers/test/nvidia.test.ts` still reference the dead
id — separate follow-up.
