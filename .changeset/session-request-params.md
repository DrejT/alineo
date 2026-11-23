---
"@alineo-labs/agent-browser": minor
---

`b.session.request`: `{name}` URL placeholders filled from `params`, ref-valued `headers`, `fromStorage(origin, key)` to read a value from the session's saved localStorage, `ref(file, path, { join })` to turn an array into one string, and index paths like `content.0.id`. A missing value fails with `code: "missing_value"` before anything is sent.
