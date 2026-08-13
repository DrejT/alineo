# @alineo-labs/workflow

Lazy pipeline builder for [alineo](https://drej.dev) — retry, conditional branching, fan-out, and parallel sandboxes, all flushed in one `await`.

```bash
bun add @alineo-labs/workflow
```

**[Full documentation →](https://docs.drej.dev/docs/workflow)**

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
