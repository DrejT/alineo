---
"@alineo-labs/model-providers": patch
---

Swap the default NVIDIA NIM embedding model from `nvidia/nv-embedqa-e5-v5` to
`nvidia/nemotron-3-embed-1b`. The old model reached end of life on 2026-08-25 and now returns
`410 Gone` from `integrate.api.nvidia.com`, breaking every `createNvidiaEmbeddingProvider()`
caller that relied on the default (notably `@alineo-labs/memory`'s semantic memory).

Note: the new model emits **2048-dim** vectors (was 1024). The memory adapters size their
vector tables lazily from the first embedding seen, so fresh stores are fine, but any
persisted semantic-memory store created with the old default must be re-embedded.
