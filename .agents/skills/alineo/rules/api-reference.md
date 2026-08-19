# Key API Reference

### `new Alineo(opts: AlineoOptions)`

| Option | Type | Notes |
|---|---|---|
| `baseUrl` | `string` | `http://127.0.0.1:8080` for local dev |
| `apiKey` | `string?` | Empty string for local dev (no auth) |
| `adapter` | `IStorageAdapter` | Pass `new SQLiteAdapter(path)` |
| `useServerProxy` | `boolean?` | **Must be `true`** when server started via `alineo init` |
| `maxConcurrency` | `number?` | Cap simultaneous active sandboxes; `sandbox()` awaits a slot |

### `client.sandbox(opts: SandboxOptions): Promise<Sandbox>`

| Option | Required | Notes |
|---|---|---|
| `image` | ✅ | `"ubuntu:22.04"` or `{ uri, auth? }` |
| `resources` | ✅ | `{ cpu: "500m", memory: "256Mi" }` — server rejects without it |
| `name` | ❌ | Ledger key. Defaults to `sandbox-<8char id>` |
| `env` | ❌ | `Record<string, string>` injected into the container |
| `hooks` | ❌ | `SandboxHooks` for observability |
| `shell` | ❌ | Default shell path for all `exec()` calls (default: `/bin/sh`) |
| `timeout` | ❌ | Container lifetime in seconds |
| `entrypoint` | ❌ | Override the container entrypoint — needed for `opensandbox/code-interpreter` |
| `runId` | ❌ | Correlation ID across related sandboxes |

### `sb.exec(cmd)` → `ExecHandle`

`ExecHandle` is `PromiseLike<ExecResult>`. Three usage modes:

```ts
// 1. Await result (buffered)
const { stdout, stderr, exitCode } = await sb.exec("ls -la");

// 2. Stream to a writable
await sb.exec("npm test").pipe(process.stdout);

// 3. Capture stdout as a string
const text = await sb.exec("cat /etc/os-release").stdout();
```

Non-zero exit codes throw `CommandError` with `.exitCode`, `.stdout`, `.stderr`.

### `sb.checkpoint(tag?: string)` → `Promise<string>`

Snapshots the container. Returns the `snapshotId`. Writes `checkpoint_created`
to the ledger. The optional `tag` is persisted in the payload for named resume.

### `client.resume(sandboxId, opts?)` → `Promise<Sandbox>`

Restores the container from the most recent checkpoint (or `opts.tag`). Execs
before the checkpoint return from ledger cache without re-running on the
container. Execs after run live.

### `client.connect(sandboxId, name, opts?)` → `Promise<Sandbox>`

Reconnect to an already-running container. No snapshot involved — the container
keeps its state. Throws 409 if container is not `Running`.

### `client.environment(name, opts)` → `Environment`

Define a named, reusable sandbox environment. The first `env.sandbox()` call
runs the `setup` function and snapshots. Subsequent calls restore from the
cached snapshot.

```ts
const env = client.environment("python", {
  image: "debian:bookworm-slim",
  resources: { cpu: "500m", memory: "512Mi" },
  setup: async (sb) => {
    await sb.exec("apt-get update -qq && apt-get install -y python3-pip");
    await sb.exec("pip install numpy pandas");
  },
});

const sb = await env.sandbox();
try {
  await sb.exec("python3 -c 'import pandas; print(pandas.__version__)'").pipe(process.stdout);
} finally {
  await sb.close();
}
```
