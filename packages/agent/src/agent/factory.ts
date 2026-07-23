import { Drej } from "drej";
import { readFileSync } from "node:fs";
import type { IStorageAdapter, Sandbox } from "@drej/core";
import { readProjectConfig } from "../config";
import { validateAgentSpec, type AgentSpec } from "../schema";
import { PiAdapter, resolveEnv, parseShellExports } from "../adapters/pi";
import { AgentSnapshotStore, computeSetupHash, snapshotsPath } from "../snapshots";
import {
  assertValidSpawnDepth,
  assertValidMaxAgents,
  resolveParentSpawnDepth,
  resolveParentMaxAgents,
} from "./validation";
import type { AgentInternal } from "./internal";

function elapsed(t: number) {
  return `${Date.now() - t}ms`;
}

/** Constructor arguments for `Agent` — returned by each factory function below so the actual
 * `new Agent(...)` call stays inside `Agent`'s own static methods, which alone have access to
 * its private constructor. */
export interface AgentConstructorArgs {
  sandbox: Sandbox;
  spec: AgentSpec;
  env: Record<string, string>;
  adapter: PiAdapter;
  fromSnapshot: boolean;
}

/**
 * Load an agent spec from disk and return everything needed to construct a fully
 * initialised `Agent`. See `Agent.load()` for the public-facing docs.
 */
export async function loadAgent(
  specPath: string,
  opts: { adapter: IStorageAdapter; rebuild?: boolean; spawnDepth?: number; maxAgents?: number },
): Promise<AgentConstructorArgs> {
  const t0 = Date.now();
  const spec = validateAgentSpec(await Bun.file(specPath).json());
  const config = await readProjectConfig();
  const resolvedEnv = resolveEnv(spec.env ?? {});
  const effectiveSpawnDepth = opts.spawnDepth ?? spec.spawnDepth;
  if (effectiveSpawnDepth !== undefined) {
    assertValidSpawnDepth(effectiveSpawnDepth, "Agent.load()");
    resolvedEnv.DREJX_SPAWN_DEPTH = String(effectiveSpawnDepth);
  }
  const effectiveMaxAgents = opts.maxAgents ?? spec.maxAgents;
  if (effectiveMaxAgents !== undefined) {
    assertValidMaxAgents(effectiveMaxAgents, "Agent.load()");
    resolvedEnv.DREJX_MAX_AGENTS = String(effectiveMaxAgents);
  }
  const resources = { ...config.defaults.resources, ...(spec.resources ?? {}) };

  const client = new Drej({
    baseUrl: config.serverUrl,
    apiKey: config.apiKey,
    adapter: opts.adapter,
    useServerProxy: config.useServerProxy,
  });

  const store = new AgentSnapshotStore(snapshotsPath(config.adapterPath));
  const setupHash = computeSetupHash(spec);

  const adapter = new PiAdapter();
  let sb: Sandbox;
  let fromSnapshot = false;

  // ── Snapshot fast path ────────────────────────────────────────────────────
  if (!opts.rebuild) {
    const record = await store.get(spec.name, setupHash);
    if (record) {
      try {
        console.log(`[agent] restoring from snapshot...`);
        const t1 = Date.now();
        sb = await client.restoreSnapshot(record.snapshotId, spec.name, resources);
        console.log(`[agent] snapshot ready  ${elapsed(t1)} (${sb.sandboxId})`);
        fromSnapshot = true;
      } catch (err) {
        // Surface the real reason instead of a bare "stale" — a genuinely stale record
        // (e.g. the spec's setup actually changed) looks identical from here to the
        // OpenSandbox server having lost its snapshot store entirely (issue #20), and
        // only the underlying error tells them apart.
        const reason = err instanceof Error ? err.message : String(err);
        console.log(`[agent] snapshot restore failed (${reason}), rebuilding...`);
        await store.delete(spec.name);
      }
    }
  }

  // ── Full install path ─────────────────────────────────────────────────────
  if (!fromSnapshot) {
    console.log(`[agent] starting sandbox (${spec.name})...`);
    const t1 = Date.now();
    sb = await client.sandbox({
      image: "node:22",
      resources,
      name: spec.name,
      env: resolvedEnv,
    });
    console.log(`[agent] sandbox ready   ${elapsed(t1)} (${sb.sandboxId})`);

    console.log(`[agent] installing Pi CLI...`);
    const t2 = Date.now();
    await adapter.install(sb!, spec);
    console.log(`[agent] Pi CLI ready    ${elapsed(t2)}`);

    for (const step of spec.setup ?? []) {
      console.log(`[agent] setup: ${step.name}...`);
      const ts = Date.now();
      const cmd = step.cwd ? `cd ${step.cwd} && ${step.run}` : step.run;
      await sb!.exec(cmd);
      console.log(`[agent] setup done      ${elapsed(ts)} (${step.name})`);
    }

    console.log(`[agent] checkpointing...`);
    const t3 = Date.now();
    const snapshotId = await sb!.checkpoint();
    await store.save({
      specName: spec.name,
      setupHash,
      snapshotId,
      createdAt: Date.now(),
    });
    console.log(`[agent] checkpoint done ${elapsed(t3)}`);
  }

  // ── Always: write fresh config + start bridge ─────────────────────────────
  resolvedEnv.DREJ_SANDBOX_ID = sb!.sandboxId;
  await adapter.configure(sb!, spec, resolvedEnv);

  console.log(`[agent] starting bridge...`);
  const t4 = Date.now();
  await adapter.startBridge(sb!);
  await adapter.waitReady();
  console.log(`[agent] bridge ready    ${elapsed(t4)}`);
  console.log(`[agent] total           ${elapsed(t0)}${fromSnapshot ? " (from snapshot)" : ""}`);

  return { sandbox: sb!, spec, env: resolvedEnv, adapter, fromSnapshot };
}

/**
 * Reconnect to a previously-created agent whose host process has exited. See
 * `Agent.resume()` for the public-facing docs.
 */
export async function resumeAgent(
  sandboxId: string,
  opts: { adapter: IStorageAdapter; specPath?: string },
): Promise<AgentConstructorArgs> {
  const t0 = Date.now();
  const config = await readProjectConfig();

  const client = new Drej({
    baseUrl: config.serverUrl,
    apiKey: config.apiKey,
    adapter: opts.adapter,
    useServerProxy: config.useServerProxy,
  });

  let spec: AgentSpec;
  if (opts.specPath) {
    spec = validateAgentSpec(await Bun.file(opts.specPath).json());
  } else {
    const sessions = await client.sandboxes.list();
    const session = sessions.find((s) => s.sandboxId === sandboxId);
    if (!session)
      throw new Error(`No ledger record for sandbox ${sandboxId} — pass opts.specPath explicitly`);
    spec = validateAgentSpec(await Bun.file(`./agents/${session.name}.json`).json());
  }

  const resolvedEnv = resolveEnv(spec.env ?? {});
  if (spec.maxAgents !== undefined) {
    assertValidMaxAgents(spec.maxAgents, "Agent.resume()");
    resolvedEnv.DREJX_MAX_AGENTS = String(spec.maxAgents);
  }
  if (spec.spawnDepth !== undefined) {
    assertValidSpawnDepth(spec.spawnDepth, "Agent.resume()");
    resolvedEnv.DREJX_SPAWN_DEPTH = String(spec.spawnDepth);
  }

  console.log(`[agent] reconnecting to ${sandboxId}...`);
  const t1 = Date.now();
  const sb = await client.connect(sandboxId, spec.name);
  console.log(`[agent] connected       ${elapsed(t1)}`);

  // Kill any stale bridge process before starting a fresh one.
  await sb.exec("pkill -f 'node /drej-bridge.js' 2>/dev/null; sleep 0.1; true", {
    strict: false,
  });

  const adapter = new PiAdapter();
  resolvedEnv.DREJ_SANDBOX_ID = sandboxId;
  await adapter.configure(sb, spec, resolvedEnv, { resume: true });

  console.log(`[agent] starting bridge...`);
  const t2 = Date.now();
  await adapter.startBridge(sb);
  await adapter.waitReady();
  console.log(`[agent] bridge ready    ${elapsed(t2)}`);
  console.log(`[agent] total           ${elapsed(t0)}`);

  return { sandbox: sb, spec, env: resolvedEnv, adapter, fromSnapshot: false };
}

/**
 * Connect to an already-running sandbox WITHOUT touching its Pi bridge. See
 * `Agent.attach()` for the public-facing docs.
 */
export async function attachAgent(
  sandboxId: string,
  opts: {
    adapter: IStorageAdapter;
    name: string;
    resources?: { cpu: string; memory: string; gpu?: string };
  },
): Promise<AgentConstructorArgs> {
  const config = await readProjectConfig();
  const client = new Drej({
    baseUrl: config.serverUrl,
    apiKey: config.apiKey,
    adapter: opts.adapter,
    useServerProxy: config.useServerProxy,
  });
  const resources = opts.resources ?? config.defaults.resources;
  const sb = await client.connect(sandboxId, opts.name, { resources });
  let envFile: string;
  try {
    envFile =
      sandboxId === process.env.DREJ_SANDBOX_ID
        ? readFileSync("/etc/drej-env", "utf8")
        : await sb.readFile("/etc/drej-env");
  } catch {
    envFile = "";
  }
  const env = parseShellExports(envFile);
  const stubSpec: AgentSpec = { name: opts.name, cli: "pi" };
  return { sandbox: sb, spec: stubSpec, env, adapter: new PiAdapter(), fromSnapshot: false };
}

/**
 * Fork `self`'s live sandbox into a brand-new independent sandbox running its
 * own Pi bridge, per `childSpecPath`. See `Agent.spawn()` for the public-facing docs.
 */
export async function spawnChild(
  self: AgentInternal,
  childSpecPath: string,
  opts: { spawnDepth?: number; maxAgents?: number } = {},
): Promise<AgentConstructorArgs> {
  const parentDepth = resolveParentSpawnDepth(process.env.DREJX_SPAWN_DEPTH, opts.spawnDepth);
  const parentMax = resolveParentMaxAgents(process.env.DREJX_MAX_AGENTS, opts.maxAgents);
  if (parentMax !== undefined && parentMax <= 0) {
    throw new Error(`Agent.spawn() refused: max-agents budget exhausted (0 remaining).`);
  }

  const childSpec = validateAgentSpec(await Bun.file(childSpecPath).json());
  const childEnv = resolveEnv(childSpec.env ?? {});
  childEnv.DREJX_SPAWN_DEPTH = String(parentDepth - 1);
  if (parentMax !== undefined) childEnv.DREJX_MAX_AGENTS = String(parentMax - 1);

  console.log(`[agent] forking sandbox for spawn (${childSpec.name})...`);
  const t0 = Date.now();
  const forkedSb = await self.sandbox.fork(childSpec.name);
  console.log(`[agent] fork ready      ${elapsed(t0)} (${forkedSb.sandboxId})`);

  const adapter = new PiAdapter();
  childEnv.DREJ_SANDBOX_ID = forkedSb.sandboxId;
  await adapter.configure(forkedSb, childSpec, childEnv);

  console.log(`[agent] starting bridge...`);
  const t1 = Date.now();
  await adapter.startBridge(forkedSb, Object.keys(self.env));
  await adapter.waitReady();
  console.log(`[agent] bridge ready    ${elapsed(t1)}`);

  // The forked sandbox's actual ledger name (auto-generated by fork, not
  // childSpec.name) is what `drejx agents` displays and what future forks
  // would derive a `fork-<name>-<id>` label from — report that as this
  // Agent's name, not the spec's own.
  const namedChildSpec: AgentSpec = { ...childSpec, name: forkedSb.name };
  return { sandbox: forkedSb, spec: namedChildSpec, env: childEnv, adapter, fromSnapshot: false };
}
