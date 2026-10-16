import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAdapter } from "../../src/adapters/codex";
import type { FakeScenario, HarnessSandbox } from "../../src/harness";

const dir = mkdtempSync(join(tmpdir(), "alineo-codex-"));
const bridgeSrc = fileURLToPath(new URL("../../dist/codex-bridge.cjs", import.meta.url));
const stubCodex = fileURLToPath(new URL("./stub-codex.mjs", import.meta.url));
const procs: Array<ReturnType<typeof Bun.spawn>> = [];

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port;
  void server.stop(true);
  if (port === undefined) throw new Error("could not find a free port");
  return port;
}

/** Stop every bridge started and remove the temp files. Call from `afterAll`. */
export function stopCodexBridges(): void {
  for (const p of procs) {
    try {
      p.kill();
    } catch {}
  }
  procs.length = 0;
  rmSync(dir, { recursive: true, force: true });
}

/**
 * The real `CodexAdapter` and the real built bridge (`dist/codex-bridge.cjs`) in a `node`
 * process, with `codex` replaced by `stub-codex.mjs` playing `scenario`.
 * Needs `bun run build` first.
 */
export async function startCodexBridge(
  scenario: FakeScenario | { kind: "hang"; finishOnSteer?: boolean },
  opts: { permissions?: object } = {},
): Promise<CodexAdapter> {
  mkdirSync(dir, { recursive: true });
  const port = freePort();
  const bridgePath = join(dir, `bridge-${port}.cjs`);
  writeFileSync(bridgePath, await Bun.file(bridgeSrc).text());
  const configPath = join(dir, `codex-${port}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      model: "stub",
      permissions: opts.permissions ?? {
        default: "ask",
        rules: [],
        disabledTools: [],
        restrictToTools: [],
      },
    }),
  );
  procs.push(
    Bun.spawn(["node", bridgePath], {
      env: {
        ...process.env,
        ALINEO_BRIDGE_PORT: String(port),
        ALINEO_CODEX_BIN: stubCodex,
        ALINEO_CODEX_CONFIG: configPath,
        ALINEO_CODEX_THREAD_FILE: join(dir, `thread-${port}`),
        ALINEO_ENV_FILE: join(dir, "no-env"),
        ALINEO_STUB_SCENARIO: JSON.stringify(scenario),
      },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const sandbox: HarnessSandbox = {
    exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    proxy: () => Promise.resolve({ url: `http://127.0.0.1:${port}`, headers: {} }),
    writeFile: () => Promise.resolve(),
  };
  const adapter = new CodexAdapter();
  await adapter.reattach(sandbox);
  await adapter.waitReady(30_000);
  return adapter;
}
