# @alineo-labs/workflow

Lazy pipeline builder for [alineo](https://alineo.tech) — retry, conditional branching, fan-out, and parallel sandboxes, all flushed in one `await`.

```bash
bun add @alineo-labs/workflow
```

**[Full documentation →](https://docs.alineo.tech/docs/workflow)**

---

## How it works

`workflow(client).sandbox(opts, fn)` returns a builder. The `fn` callback receives a `SandboxBuilder` — all methods on it queue operations synchronously. Nothing runs until you `await .pipe()` or `.result()`.

```ts
import { workflow } from "@alineo-labs/workflow";

await workflow(client)
  .sandbox({ image: "node:20-slim", resources: { cpu: "1", memory: "512Mi" } }, (sb) => {
    sb.exec("npm ci");
    sb.exec("npm run build");
    sb.exec("npm test");
  })
  .pipe(process.stdout);
```

---

## Retry

```ts
sb.retry(
  3,
  (r) => {
    r.exec("flaky-network-call");
  },
  { delayMs: 500, backoff: "exponential" },
);
```

## Conditional branching

The predicate receives `{ stdout, exitCode, vars }` from the previous step.

```ts
sb.exec("test -f /app/build.sh", { strict: false });
sb.when(
  (ctx) => ctx.exitCode === 0,
  (s) => s.exec("bash /app/build.sh"),
  (s) => s.exec("echo 'no build script'"),
);
```

## Fan-out

```ts
sb.forEach(
  ["a.ts", "b.ts", "c.ts"],
  (s, file) => {
    s.exec(`tsc --noEmit ${file}`);
  },
  { concurrency: 4 },
);
```

## Capture a value

`sb.readFile(path, as)` stores file contents in `vars[as]` on the result object.

```ts
const { vars } = await workflow(client)
  .sandbox({ image: "node:20-slim", resources: { cpu: "500m", memory: "256Mi" } }, (sb) => {
    sb.exec(`node -e "require('fs').writeFileSync('/out.txt', process.version)"`);
    sb.readFile("/out.txt", "nodeVersion");
  })
  .result();

console.log(vars.nodeVersion); // "v20.x.x"
```

## Capture one command's output

`as` stores that command's own stdout in `vars`. `parse: "json"` parses it. Workflow-only options are removed before the command reaches the sandbox.

```ts
sb.exec("agent-browser --json get url", { as: "page", parse: "json", strict: false });
sb.when(
  (ctx) => (ctx.vars.page as { success: boolean }).success,
  (s) => s.exec("echo signed in"),
);
```

## Binary files

`readFile` decodes UTF-8, so it corrupts a spreadsheet or a zip. Use the byte ops for those.

```ts
sb.writeFileBytes("/tmp/state.json", savedBytes);
sb.readFileBytes("/tmp/report.xlsx", "report"); // vars.report is a Uint8Array
```

## Credentials and egress

The sandbox needs `credentialProxy: true` and a `networkPolicy`. The value stays on the host. The egress proxy injects it into matching requests.

```ts
sb.setCredential("portal-password", password, {
  host: "seller.example.com",
  injection: { type: "substitution", placeholder: "PORTAL_PASSWORD", in: ["body"] },
});
sb.patchEgress([{ action: "allow", target: "downloads.example.com" }]);
sb.deleteEgress(["downloads.example.com"]);
```

## Step events

`onEvent` reports `workflow.started`, `step.started`, `step.completed`, `step.failed`, `workflow.completed` and `workflow.failed`. A step is one leaf op. Events carry the step's index, `name` (from `exec(cmd, { name })`, or the op kind), duration and exit code. They never carry command text, file contents, credential values or `vars`, so you can store them as a run record.

```ts
await workflow(client, { onEvent: (e) => runLog.push(e) })
  .sandbox(opts, (sb) => sb.exec("npm test", { name: "test" }))
  .result();
```

## Parallel sandboxes

Run the same builder across multiple configs simultaneously:

```ts
await workflow(client)
  .parallel(
    [
      { image: "node:18-slim", resources: { cpu: "500m", memory: "256Mi" } },
      { image: "node:20-slim", resources: { cpu: "500m", memory: "256Mi" } },
      { image: "node:22-slim", resources: { cpu: "500m", memory: "256Mi" } },
    ],
    (sb) => {
      sb.exec("node --version");
      sb.exec("npm ci && npm test");
    },
  )
  .pipe(process.stdout);
```

## Sequential pipeline

Pass work across sandboxes in order, each starting fresh:

```ts
await workflow(client)
  .sequence([
    {
      image: "node:20-slim",
      resources: { cpu: "1", memory: "512Mi" },
      run: (sb) => {
        sb.exec("npm ci");
        sb.exec("npm run build");
      },
    },
    {
      image: "alpine:3",
      resources: { cpu: "500m", memory: "256Mi" },
      run: (sb) => {
        sb.exec("ls /app/dist");
      },
    },
  ])
  .pipe(process.stdout);
```

---

## License

Apache 2.0
