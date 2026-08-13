---
"alineo": major
"alineo-cli": major
"@alineo-labs/core": major
"@alineo-labs/opensandbox": major
"@alineo-labs/agent": major
"@alineo-labs/sqlite": major
"@alineo-labs/postgres": major
"@alineo-labs/otel": major
"@alineo-labs/workflow": major
"@alineo-labs/flue": major
---

Rename the project from drej to alineo. Breaking change: every published package's name
changed.

- SDK: `drej` → `alineo` (`import { Drej } from "drej"` → `import { Alineo } from "alineo"`).
  `DrejError`/`DrejOptions` → `AlineoError`/`AlineoOptions`.
- CLI: `drejx` → `alineo-cli` (npm package name), binary command `drejx` → `alineo`
  (`drejx init` → `alineo init`, etc). `~/.config/drejx/` → `~/.config/alineo/`,
  project-local `drej.config.json` → `alineo.config.json`, `.drej/` → `.alineo/`.
- Scoped packages: `@drej/*` → `@alineo-labs/*` across all 14 previously-scoped packages.
- Environment variables: `DREJ_*`/`DREJX_*` → `ALINEO_*` (the two-prefix split collapses to
  one now that the CLI binary and SDK class share the same root name).

This is a code-level rename only — package/CLI/env-var/config-path identifiers. GitHub
org/repo, deploy domains, and Cloudflare project names are unchanged in this pass (that
infra isn't provisioned under the new name yet).
