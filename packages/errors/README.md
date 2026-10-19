# @alineo-labs/errors

Stable error codes and the `AlineoError` base class shared by every alineo package.

```ts
import { AlineoError, errorCodeOf, isRetryable } from "@alineo-labs/errors";

try {
  await sb.exec("npm test");
} catch (err) {
  if (errorCodeOf(err) === "EXEC_NOT_READY") {
    // the sandbox is Running but execd never answered
  }
  if (isRetryable(err)) {
    // the same call may succeed later
  }
}
```

## Why a separate package

`@alineo-labs/opensandbox` is the lowest layer and has no dependencies, and `@alineo-labs/core`
depends on it. An error class in core could not be thrown by the OpenSandbox client. This package
has no dependencies and sits under every other one, so each layer can raise and read the same
codes. It is published and kept external (not bundled) so there is one `AlineoError` class at
runtime. `isAlineoError()` also recognises an error from a second copy.

## Rules

- Branch on `code`, never on a class name or message text.
- A code is a contract. Do not rename, reuse, or repurpose one.
- Add a code only when a real failure needs it. `scripts/check-vocabulary.ts` fails on a code
  that is thrown but not defined here.
- `details` holds ids and counts. Never put a secret in an error.
