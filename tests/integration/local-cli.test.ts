/**
 * The local `alineo-cli`, installed into a real sandbox from this checkout's own build.
 *
 * Every spec that spawns child agents does `npm install -g alineo-cli` in its setup, which
 * pulls whatever is on npm. While a branch is renaming the vocabulary, that is exactly the
 * wrong binary: it writes `cli`/`cliVersion` and the old flat event names, and a spec in the
 * new spelling fails *inside the sandbox*, minutes in, reading like a bad spec rather than
 * version skew. `scripts/local-cli-spec.ts` swaps those steps for the local build; this is
 * what proves the swap works before anything stakes a swarm run on it.
 *
 * Deliberately asks the binary directly rather than driving an agent: a model in the loop
 * would let a CLI-install problem hide behind a slow or empty turn.
 *
 * Requires OpenSandbox (`alineo init`). ~60s: it builds and packs eleven packages.
 */
import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SandboxHandle } from "@alineo-labs/sandbox";
import { localCliSetupSteps } from "../../scripts/local-cli-spec.ts";

// `useServerProxy` defaults on: an `alineo init` (Docker) server hands out
// container-internal endpoints that aren't reachable from the host. Set
// `OPEN_SANDBOX_SERVER_PROXY=false` for a bare `uvx opensandbox-server`, where the
// direct endpoints work.
const USE_SERVER_PROXY = process.env.OPEN_SANDBOX_SERVER_PROXY !== "false";

/**
 * The CLI posts a telemetry event per invocation, to the real ingest server. This test runs
 * `alineo start` twice, so without this every run of the suite writes two `start`/`error` rows
 * into production analytics from a version that was never published — six of them are already
 * in there from writing this file.
 */
const NO_TELEMETRY = "export ALINEO_TELEMETRY_DISABLED=1";

/** The step every spec that installs the CLI starts with — its shebang is `#!/usr/bin/env bun`. */
const INSTALL_BUN = {
  name: "Install bun (alineo's own shebang requires it)",
  run: "curl -fsSL https://bun.sh/install | bash && ln -sf /root/.bun/bin/bun /usr/local/bin/bun",
};

let sb: SandboxHandle;

beforeAll(async () => {
  const client = new Sandbox({
    baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
    apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
    adapter: new SQLiteAdapter(":memory:"),
    useServerProxy: USE_SERVER_PROXY,
  });
  sb = await client.sandbox({
    image: "node:22",
    resources: { cpu: "1000m", memory: "2Gi" },
    name: "local-cli-test",
  });

  for (const step of [INSTALL_BUN, ...(await localCliSetupSteps())]) {
    const { exitCode, stderr } = await sb.exec(step.run, { strict: false });
    if (exitCode !== 0)
      throw new Error(`setup step "${step.name}" failed:\n${stderr.slice(0, 800)}`);
  }
}, 600_000);

afterAll(async () => {
  await sb?.close();
});

test("the binary on PATH is the local build, not the published one", async () => {
  const { stdout } = await sb.exec(`${NO_TELEMETRY} && which alineo && alineo --version`);
  expect(stdout).toContain("/usr/local/bin/alineo");
  // Whatever this checkout says it is. A published install would answer with npm's version.
  const local = await Bun.file(`${import.meta.dir}/../../packages/cli/package.json`).json();
  expect(stdout).toContain(local.version);
});

test("its help text is the renamed command vocabulary", async () => {
  // `strict: false` because `--help` is not a registered command name: `index.ts` prints the
  // help and then `if (cmd) process.exit(1)`. That is how it behaves on main too, and it is
  // the text this test is about, not the status.
  const { stdout } = await sb.exec(`${NO_TELEMETRY} && alineo --help`, { strict: false });
  expect(stdout).toContain("alineo start <spec>");
  // `spawn` used to take a spec path and mean "start a root agent". It now takes a parent
  // session name, so a help line offering it a `.json` would be the old CLI.
  expect(stdout).not.toMatch(/alineo spawn\s+\S*\.json/);
});

test("a spec in the new vocabulary gets past validation", async () => {
  await sb.writeFile(
    "/tmp/new.json",
    JSON.stringify({ name: "probe", harness: "pi", provider: "nvidia", model: "m" }),
  );
  const { stdout, stderr } = await sb.exec(`${NO_TELEMETRY} && alineo start /tmp/new.json`, {
    strict: false,
  });
  // It fails later, on the network — no OpenSandbox is reachable from in here. What matters
  // is that it got past the spec.
  expect(stdout + stderr).not.toContain("Invalid agent spec");
});

test("a spec in the old vocabulary is rejected, and the error names the rename", async () => {
  await sb.writeFile(
    "/tmp/old.json",
    JSON.stringify({ name: "probe", cli: "pi", provider: "nvidia", model: "m" }),
  );
  const { stdout, stderr } = await sb.exec(`${NO_TELEMETRY} && alineo start /tmp/old.json`, {
    strict: false,
  });
  const output = stdout + stderr;
  expect(output).toContain("Invalid agent spec");
  expect(output).toContain("must have a 'harness' field");
  expect(output).toContain("This spec uses 'cli', renamed to 'harness'");
});
