---
"alineo": patch
"@alineo-labs/sandbox": patch
---

Fix a fresh Pi 1.2.x install, and rebuild an environment whose snapshot image is gone.

- `alineo`: installing Pi `1.2.x` named an AWS SDK version the npm registry no longer serves, so every fresh agent start failed with `ETARGET`. The install command now also names `@aws-sdk/credential-provider-http@3.972.76` for `1.2.x` specifiers.
- `@alineo-labs/sandbox`: `env.sandbox()` threw `SANDBOX_IMAGE_PULL_FAILED` when the server still listed the snapshot but its image was gone. It now rebuilds the environment once, as alineod already does.
