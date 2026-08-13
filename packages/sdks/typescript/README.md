# alineo

Sandboxes as objects. Spawn live containers, run code, checkpoint state — from TypeScript.

```bash
bun add alineo @alineo-labs/sqlite
```

**[Full documentation →](https://docs.drej.dev/docs/core)**

---

## Quickstart

```ts
import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Alineo({
  baseUrl: "http://localhost:8080",
  adapter: new SQLiteAdapter("./ledger.db"),
});

const sb = await client.sandbox({
  image: "ubuntu:22.04",
  resources: { cpu: "500m", memory: "512Mi" },
});

const { stdout } = await sb.exec("node --version");
console.log(stdout); // v20.x.x

await sb.close();
```

---

## Core concepts

**Sandbox as object** — `client.sandbox()` returns a live `Sandbox`. Call exec, file ops, checkpoint, and fork directly on it. No special API needed for multiple sandboxes — just multiple variables.

**ExecHandle** — `sb.exec("cmd")` returns an `ExecHandle` — a `PromiseLike<ExecResult>` with streaming built in.

```ts
// Await result
const { stdout, stderr, exitCode } = await sb.exec("npm test");

// Stream to a writable
await sb.exec("npm run build").pipe(process.stdout);

// Async iteration
for await (const chunk of sb.exec("npm run build").stdout()) {
  process.stdout.write(chunk);
}
```

**Durable ledger** — every exec is written to the storage adapter. `client.resume(sandboxId)` restores the container and replays cached results from before the last checkpoint.

---

## File operations

```ts
await sb.writeFile("/app/main.py", "print('hello')");
const content = await sb.readFile("/app/main.py");

await sb.createDirectory("/app/dist");
const info = await sb.getFileInfo("/app/main.py");

// In-place patch
await sb.replaceInFiles([{ path: "/app/main.py", old: "hello", new: "world" }]);

// Search, move, delete
const files = await sb.searchFiles("*.py", "/app");
await sb.moveFile("/tmp/out.txt", "/app/out.txt");
await sb.deleteFile("/app/main.py");

// Copy to another sandbox
await sb.transfer("/app/output.json", anotherSb);
```

## Checkpoint and resume

```ts
const sb = await client.sandbox({
  image: "ubuntu:22.04",
  resources: { cpu: "500m", memory: "512Mi" },
});

await sb.exec("apt-get install -y curl");
await sb.checkpoint("after-setup");
await sb.close();

// Later — or after a crash
const restored = await client.resume(sb.sandboxId);
await restored.exec("curl https://example.com").pipe(process.stdout);
await restored.close();
```

## Environments

Define a named environment with a setup recipe. Built once, restored from snapshot on every subsequent call.

```ts
const env = client.environment("python-data", {
  image: "python:3.11-slim",
  resources: { cpu: "1", memory: "1Gi" },
  setup: async (sb) => {
    await sb.exec("pip install numpy pandas scikit-learn");
  },
});

const sb = await env.sandbox(); // ~2s after first run
await sb.exec("python3 -c 'import pandas; print(pandas.__version__)'").pipe(process.stdout);
await sb.close();
```

## Forking

```ts
await sb.exec("npm ci");
const fork = await sb.fork();

await Promise.all([
  sb.exec("npm test").pipe(process.stdout),
  fork.exec("npm run build").pipe(process.stdout),
]);

await Promise.all([sb.close(), fork.close()]);
```

## Error handling

```ts
import { CommandError } from "alineo";

try {
  await sb.exec("exit 1"); // strict: true by default
} catch (e) {
  if (e instanceof CommandError) {
    console.log(e.exitCode, e.command);
  }
}

// Opt out of strict mode
const { exitCode } = await sb.exec("exit 1", { strict: false });
```

---

## Configuration

```ts
const client = new Alineo({
  baseUrl: "http://localhost:8080", // OpenSandbox server URL
  apiKey: "", // API key (empty for local dev)
  adapter: new SQLiteAdapter("./alineo.db"),
  maxConcurrency: 4, // cap simultaneous active sandboxes
  useServerProxy: true, // required when server runs in Docker via alineo init
});
```

---

## Local setup

Requires a running [OpenSandbox](https://open-sandbox.ai) instance:

```bash
bunx alineo-cli init        # starts OpenSandbox in Docker, recommended
# or
uvx opensandbox-server # manual, see docs for ~/.sandbox.toml config
```

---

## License

Apache 2.0
