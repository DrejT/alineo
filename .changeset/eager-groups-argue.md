---
---

Docs site only, no publishable package changes: dynamically generate the versioned
docs registry (source.config.ts, src/lib/source.ts, public/_redirects) from whatever
content/docs/<product>/vX.Y/ folders exist on disk, instead of hand-listing each
version — a version cut is now "add the content folder, run `bun run build`",
nothing to hand-edit. Also drops the "v" from doc version URLs (/docs/core/0.1, not
/docs/core/v0.1), with a permanent redirect from the old, already-indexed
/docs/core/v0.1 URL. The version switcher now shows itself automatically once a
second version exists (previously unconditionally hidden).
