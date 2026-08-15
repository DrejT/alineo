---
"@alineo-labs/flue": patch
"@alineo-labs/otel": patch
"@alineo-labs/postgres": patch
"@alineo-labs/sqlite": patch
"@alineo-labs/agent": patch
"alineo-cli": patch
"@alineo-labs/core": patch
"@alineo-labs/opensandbox": patch
"alineo": patch
"@alineo-labs/workflow": patch
---

Remove `private: true` from the 10 publishable packages so they can actually be published to
npm. No functional or API changes — this is the last step of npm-publish readiness (repository
URLs, `publishConfig`, and `bin`/`repository` fields were already correct).
