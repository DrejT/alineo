---
"@alineo-labs/opensandbox": patch
---

`OpenSandboxError` now carries a readable message. OpenSandbox answers an error with a JSON body such as `{"code":"DOCKER::SANDBOX_NOT_FOUND","message":"Sandbox sb-1 not found."}`, and the client used to put that raw text in `message`, so it showed up as JSON in logs and error output. `message` is now the sentence followed by the code (`Sandbox sb-1 not found. (DOCKER::SANDBOX_NOT_FOUND)`), the code is on a new `error.code` field, and a body that isn't that shape is used as it was. If you parsed `error.message` as JSON, read `error.code` and `error.status` instead.
