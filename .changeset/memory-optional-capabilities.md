---
"@alineo-labs/memory": minor
---

Add two optional provider capabilities, in the same shape as `isPrunable` / `isBulkRememberable`:

- `IRecentSemanticMemoryProvider` / `isRecentListable()` — `listRecent(ref, limit)`, the newest
  facts without enumerating the resource's whole set.
- `IPagedWorkingMemoryProvider` / `isPageable()` — `listPage(ref, { after, limit })`, one page of
  working memory in ascending UTF-8 key order. It returns an ordered list of `[key, value]` pairs
  rather than a record, because a JavaScript object reorders integer-like keys (`"9"` before
  `"10"`) and so would scramble the order a page cursor depends on.

Neither is required of a provider. A caller that wants a page asks with the guard and falls back to
`listAll()` / `list()` when the backend can't answer directly, so a backend without the capability
is slower, never wrong.
