import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { defineProviderContract } from "./src/contract";

/**
 * Binds the provider contract to OpenSandbox.
 *
 * Needs a live server: `alineo init`, or `uvx opensandbox-server`. `OPEN_SANDBOX_SERVER_PROXY`
 * defaults on because an `alineo init` (Docker) server hands out container-internal endpoints a
 * host cannot reach. Set it to `false` for a bare `uvx opensandbox-server`.
 *
 * `OPEN_SANDBOX_RUNTIME=gvisor` marks `/tmp` as a known snapshot loss: gVisor mounts it as a
 * separate tmpfs, which `docker commit` does not capture. Leave it unset on runc.
 */
const USE_SERVER_PROXY = process.env.OPEN_SANDBOX_SERVER_PROXY !== "false";
const GVISOR = process.env.OPEN_SANDBOX_RUNTIME === "gvisor";

defineProviderContract({
  name: "opensandbox",
  createClient: () =>
    new Sandbox({
      baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
      apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
      adapter: new SQLiteAdapter(":memory:"),
      useServerProxy: USE_SERVER_PROXY,
    }),
  image: "python:3.11-slim",
  resources: { cpu: "500m", memory: "512Mi" },
  capabilities: { snapshot: true, endpoint: true },
  snapshotKnownLosses: GVISOR ? ["/tmp/contract-h.txt"] : [],
  sseIdleSeconds: Number(process.env.CONTRACT_SSE_IDLE_SECONDS ?? 20),
});
