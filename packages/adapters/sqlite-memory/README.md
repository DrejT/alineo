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
import {
  SQLiteWorkingMemoryProvider,
  SQLiteSemanticMemoryProvider,
} from "@alineo-labs/sqlite-memory";

const memory = new Memory({
  workingMemory: new SQLiteWorkingMemoryProvider("./alineo-memory.db"),
  semantic: new SQLiteSemanticMemoryProvider("./alineo-memory.db", myEmbeddingProvider),
});
```

Both providers migrate and enable WAL mode on construction — no separate `connect()` step.
Pass the same file path to both to keep working and semantic memory in one file, or different
paths to keep them separate.

Semantic recall ranks using [`sqlite-vec`](https://github.com/asg017/sqlite-vec)'s native
`vec0` virtual table — a real vector index, not a JS-level scan — whenever the extension loads
successfully on the current platform (`sqlite-vec` ships prebuilt binaries for the common
platforms; verified working here on win32/x64). Each resource's vectors are isolated via
`vec0`'s own partition-key mechanism, applied natively during the KNN search itself rather
than as a filter afterward — the latter would silently return too few or the wrong results
whenever another resource's facts happen to be nearer to the query. Check
`provider.hasVectorIndex` to see which path is active; if the extension fails to load, this
falls back to the same in-JS cosine scan `InMemorySemanticMemoryProvider` uses — correct, just
slower.

---

## License

Apache 2.0
