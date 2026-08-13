# @alineo-labs/otel

OpenTelemetry hooks adapter for [alineo](https://alineo.tech). Emits distributed traces for sandbox lifecycle events — sandbox creation, exec calls, and checkpoints.

```bash
bun add @alineo-labs/otel
```

---

## Usage

```ts
import { otelHooks } from "@alineo-labs/otel";

const sb = await client.sandbox({
  image: "ubuntu:22.04",
  resources: { cpu: "500m", memory: "512Mi" },
  hooks: otelHooks(tracer),
});
```

### Emitted spans

| Span                 | Emitted on                  |
| -------------------- | --------------------------- |
| `sandbox.run`        | Sandbox created → closed    |
| `sandbox.exec`       | Each `sb.exec()` call       |
| `sandbox.checkpoint` | Each `sb.checkpoint()` call |

### Custom span options

```ts
otelHooks(tracer, {
  attributes: { "deployment.env": "production" },
});
```

---

## License

Apache 2.0
