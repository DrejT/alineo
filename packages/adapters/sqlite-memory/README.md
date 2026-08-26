# @alineo-labs/sqlite-memory

File-based `@alineo-labs/memory` backend for [alineo](https://alineo.tech), via `bun:sqlite`. Zero infrastructure, survives process restarts.

```bash
bun add @alineo-labs/sqlite-memory
```

For a shared, multi-process backend, use [`@alineo-labs/postgres-memory`](https://github.com/DrejT/alineo/tree/main/packages/adapters/postgres-memory) instead.

---

## Usage

```ts
import { Memory } from "@alineo-labs/memory";
import { SQLiteWorkingMemoryProvider, SQLiteSemanticMemoryProvider } from "@alineo-labs/sqlite-memory";

const memory = new Memory({
  workingMemory: new SQLiteWorkingMemoryProvider("./alineo-memory.db"),
  semantic: new SQLiteSemanticMemoryProvider("./alineo-memory.db", myEmbeddingProvider),
});
```

Both providers migrate and enable WAL mode on construction — no separate `connect()` step.
Pass the same file path to both to keep working and semantic memory in one file, or different
paths to keep them separate.

Semantic recall ranks by an in-JS cosine-similarity scan over every row for the resource —
`bun:sqlite` has no vector index. Fine for local/dev scale; reach for
`@alineo-labs/postgres-memory` (or add `pgvector` yourself) for real ANN search at scale.

---

## License

Apache 2.0
