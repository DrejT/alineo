---
---

alineod only (private app), no publishable package changes. A turn that ends because the model API refused the request (overloaded, a 429, a 404 for a model the account can't use) is no longer recorded as `success`. Pi ends such a turn normally, with `stopReason: "error"` on its last assistant message; alineod now reads it, in both the streaming path and the polling (catch-up) path, and ends the agent `failed` with the provider's message in `error`. Text produced before the error is kept as the result. Only the last message counts, so an error that a retry got past doesn't fail the turn. This also stops a `waitFor` quorum from counting agents that did nothing.
