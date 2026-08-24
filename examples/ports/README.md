# ports

Demonstrates `sb.proxy()`: start an HTTP server inside a sandbox and send requests to it from the host process via the OpenSandbox server proxy.

## Setup

```bash
bunx alineo-cli init   # starts OpenSandbox in Docker (one-time setup)
```

## Run

```bash
bun install
bun start
```

## What it does

1. Creates a `node:22` sandbox and writes a simple HTTP server to `/server.js`
2. Starts the server on port 3000 in the background
3. Calls `sb.proxy(3000)` to get a proxy URL and auth headers
4. Sends two requests from the host process and prints the JSON responses

## Notes

With `useServerProxy: true` (the default), `sb.proxy()` returns a URL that routes through the OpenSandbox server (`http://127.0.0.1:8080/sandboxes/{id}/proxy/3000`). This works regardless of Docker networking because the server relays the request to the container on your behalf.
