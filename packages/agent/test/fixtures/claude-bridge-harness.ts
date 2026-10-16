import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code";
import type { FakeScenario, HarnessSandbox } from "../../src/harness";

const dir = mkdtempSync(join(tmpdir(), "alineo-claude-"));
const bridgeSrc = fileURLToPath(new URL("../../dist/claude-bridge.cjs", import.meta.url));
const stubSdk = fileURLToPath(new URL("./stub-claude-sdk.mjs", import.meta.url));
const procs: Array<ReturnType<typeof Bun.spawn>> = [];

/** A port nothing is listening on. Two test files can run in one process, so a fixed range collides. */
function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port;
  void server.stop(true);
  if (port === undefined) throw new Error("could not find a free port");
  return port;
}

/** Stop every bridge started and remove the temp files. Call from `afterAll`. */
export function stopClaudeBridges(): void {
  for (const p of procs) {
    try {
      p.kill();
    } catch {}
  }
  procs.length = 0;
  rmSync(dir, { recursive: true, force: true });
}

/**
 * The real `ClaudeCodeAdapter` and the real built bridge (`dist/claude-bridge.cjs`) in a `node`
 * process, with the Agent SDK replaced by `stub-claude-sdk.mjs` playing `scenario`.
 * Needs `bun run build` first.
 */
export async function startClaudeBridge(
  scenario: FakeScenario,
  opts: { permissions?: object } = {},
): Promise<ClaudeCodeAdapter> {
  // A test file's `afterAll` removes the directory, and the next file reuses this module.
  mkdirSync(dir, { recursive: true });
  const port = freePort();
  const bridgePath = join(dir, `bridge-${port}.cjs`);
  writeFileSync(bridgePath, await Bun.file(bridgeSrc).text());
  const configPath = join(dir, `claude-${port}.json`);
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
        ALINEO_CLAUDE_SDK_PATH: stubSdk,
        ALINEO_CLAUDE_CONFIG: configPath,
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
  const adapter = new ClaudeCodeAdapter();
  await adapter.reattach(sandbox);
  await adapter.waitReady(30_000);
  return adapter;
}
