---
"alineo": minor
"@alineo-labs/schema": minor
---

Checkpoints can now be kept off the machine. Pass a `BlobStore` to `takeCheckpoint()` and each tarball is uploaded to it as well as written to the host disk, and `agent.checkpointed` gains `remoteRef` (where the object is) and `uploadError` (why an upload failed, when one was tried). `S3BlobStore` covers S3, R2 and MinIO through `Bun.S3Client`. `MemoryBlobStore` is a fake for tests.

`Alineo.resume()` and `Alineo.reattach()` take the same `blobStore` option. When the sandbox is gone and the host's own checkpoint file is gone too, the restore downloads the checkpoint, and if it cannot read the newest one it tries the next older one before it falls back to a blank session.

New exports: `BlobStore`, `S3BlobStore`, `MemoryBlobStore`, `findCheckpoints`, `fetchCheckpoint`, `pickRestorable`, `extractCheckpoint`, `pruneRemoteCheckpoints`.

Nothing changes unless you pass a store. A failed upload never fails a checkpoint.
