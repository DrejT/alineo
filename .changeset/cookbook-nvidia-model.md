---
---

Cookbooks + examples + a test: replace every reference to the end-of-life NVIDIA NIM model
`nvidia/nemotron-3-nano-30b-a3b` with `nvidia/nemotron-3.5-lightning-30b-a3b`.

`nvidia/nemotron-3-nano-30b-a3b` reached end-of-life on the NVIDIA NIM API on 2026-09-01 —
`/v1/chat/completions` returns `410 Gone`. Every agent spec pinning it silently produced an
empty event stream while still exiting 0.

- `cookbooks/{ai-agent-bugfix,persistent-agent-memory,credential-scoped-agent}/agents/*.json`
  — verified all three end-to-end against a local OpenSandbox server with the new model.
- `examples/{pi-agent,rlm-repo-fanout,rlm-master,human-in-the-loop,agent-egress-approval}`
  agent specs (including the ones printf'd into a setup step).
- `packages/model-providers/test/nvidia.test.ts` — the id is only used as an arbitrary string
  fixture; tests still pass.
- `examples/rlm-repo-fanout/{README,RUBRIC}.md` — updated the "current spec" references and
  noted that the benchmark tables predate the EOL. Those figures are left as the historical
  record; the `rlm-*` examples' master model (`nvidia/nvidia-nemotron-nano-9b-v2`) is *also*
  EOL and both need a proper re-benchmark — out of scope here.
