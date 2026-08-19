# Quick-Start Workflow

### 1 — Start the local server (Docker required)

```bash
# Recommended: CLI manages Docker for you
bunx alineo-cli init

# Alternative: manual uvx
uvx opensandbox-server
```

`alineo init` writes `alineo.config.json` in the current dir and a server config
at `~/.config/alineo/server.toml`. When the server runs in Docker you **must**
pass `useServerProxy: true` to `new Alineo(...)`.

> **Windows gotcha:** `alineo init` mounts the Docker socket as
> `/var/run/docker.sock` (the Unix path) because Docker Desktop on Windows
> transparently proxies this path into its Linux VM. The Windows named pipe
> (`//./pipe/docker_engine`) **cannot** be used here — the OpenSandbox server
> is a Linux Python process that only knows the Unix socket path.

### 2 — Write a script

```ts
import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Alineo({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./.alineo/ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false", // must be true with alineo init
});

const sb = await client.sandbox({
  image: "ubuntu:22.04",
  resources: { cpu: "500m", memory: "512Mi" }, // REQUIRED — server rejects without this
  name: "my-run",                              // ledger key; auto-generated if omitted
});

try {
  const { stdout, exitCode } = await sb.exec("echo hello");
  await sb.exec("npm test").pipe(process.stdout); // stream to terminal
  await sb.checkpoint();                          // snapshot the container
} finally {
  await sb.close(); // always in finally — releases slot and writes sandbox_closed
}
```

### 3 — Run it

```bash
bun examples/hello-world/index.ts
```
