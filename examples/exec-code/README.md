# exec-code

Demonstrates `sb.execCode()` for running code through the sandbox's built-in interpreter — stateless one-shot calls and stateful sessions where variables persist across calls.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
```

## Run

```bash
bun install
bun start
```

## What it shows

| Mode      | Description                                                         |
| --------- | ------------------------------------------------------------------- |
| Stateless | Each `execCode()` call runs in an isolated context; no shared state |
| Stateful  | Calls sharing the same `context` object see each other's variables  |

Uses the `opensandbox/code-interpreter` image, which ships a Python interpreter accessible via the execd `/code` endpoint.
