---
"@alineo-labs/core": minor
"@alineo-labs/vault": minor
"alineo": minor
---

Credential injection: replace the placeholder `query` / `path` shapes with a working
`substitution` type.

`CredentialBinding.injection` (and `AgentSpec.env`'s `CredentialEnvBinding.injection`) is now:

```ts
| { type: "header"; name: string }
| { type: "substitution"; placeholder: string; in: Array<"path" | "query" | "header" | "body"> }
```

`substitution` maps onto the egress sidecar's real `passthrough` + `substitutions` auth model:
the sidecar replaces every literal occurrence of `placeholder` in the listed request surfaces
with the credential value. **The outbound request must already contain `placeholder` verbatim**
— put it in a base URL, e.g. `https://api.example.com/v1?key=__API_KEY__`. `header` injection
is unchanged and stays the recommended default.

**Migration** — the old `{ type: "query"; param }` / `{ type: "path"; segment }` shapes are
removed (they only ever threw `UnsupportedInjectionError`). Replace
`{ type: "query"; param: "k" }` with `{ type: "substitution"; placeholder: "__CRED__"; in: ["query"] }`
and add `?k=__CRED__` to the request. `sb.credentials.listBindings()` is lossy for
substitution bindings (the vault does not echo `substitutions` back) — `resume()` / `fork()`
recover the full shape from the ledger instead.
