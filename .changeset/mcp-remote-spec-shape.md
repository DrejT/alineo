---
"alineo-mcp": patch
---

In remote mode, `spec_add` and `spec_get` return a spec in the nested shape (`harness: { id, version }`, `model: { provider, id }`). They used to return the normalized form, so passing the result to `run_start` logged deprecation warnings for `provider` and `harnessVersion`, fields the caller never wrote. The server instructions also stop naming `spec_list` and `spec_get` when the server keeps no specs and does not offer those tools.
