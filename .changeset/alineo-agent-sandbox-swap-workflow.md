---
"@alineo-labs/workflow": patch
---

Internal dependency update only, no behavior change: now depends on `@alineo-labs/sandbox`
instead of `alineo` for the `Sandbox`/`ExecOptions`/`ExecCodeOptions`/`ExecResult` types
`SandboxBuilder` is built on, per the naming inversion in
[#182](https://github.com/DrejT/alineo/issues/182). `SandboxBuilder`'s own public API is
unchanged.
