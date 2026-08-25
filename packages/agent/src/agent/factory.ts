import { Sandbox } from "@alineo-labs/sandbox";
import { readFileSync } from "node:fs";
import type { IStorageAdapter, SandboxHandle } from "@alineo-labs/core";
import { readProjectConfig } from "../config";
import { validateAgentSpec, type AgentSpec } from "../schema";
import {
  PiAdapter,
  resolveEnv,
  extractCredentialBindings,
  parseShellExports,
} from "../adapters/pi";
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

/** Constructor arguments for `Alineo` — returned by each factory function below so the actual
 * `new Alineo(...)` call stays inside `Alineo`'s own static methods, which alone have access to
 * its private constructor. */
export interface AgentConstructorArgs {
  sandbox: SandboxHandle;
  spec: AgentSpec;
  env: Record<string, string>;
  adapter: PiAdapter;
  fromSnapshot: boolean;
  /** Run-correlation ID for this agent's sandbox — see `SandboxDetails.runId`. */
  runId: string;
}

/**
 * Validate `specInput` and return everything needed to construct a fully initialised `Alineo`.
 * See `Alineo.load()` for the public-facing docs.
 */
export async function loadAgent(
  specInput: AgentSpec | Record<string, unknown>,
  opts: {
    adapter: IStorageAdapter;
    rebuild?: boolean;
    spawnDepth?: number;
    maxAgents?: number;
    runId?: string;
  },
): Promise<AgentConstructorArgs> {
  const t0 = Date.now();
  const spec = validateAgentSpec(specInput);
  const config = await readProjectConfig();
  const resolvedEnv = resolveEnv(spec.env ?? {});
  const effectiveSpawnDepth = opts.spawnDepth ?? spec.spawnDepth;
  if (effectiveSpawnDepth !== undefined) {
    assertValidSpawnDepth(effectiveSpawnDepth, "Alineo.load()");
    resolvedEnv.ALINEO_SPAWN_DEPTH = String(effectiveSpawnDepth);
  }
  const effectiveMaxAgents = opts.maxAgents ?? spec.maxAgents;
  if (effectiveMaxAgents !== undefined) {
    assertValidMaxAgents(effectiveMaxAgents, "Alineo.load()");
    resolvedEnv.ALINEO_MAX_AGENTS = String(effectiveMaxAgents);
  }
  // Unlike spawnDepth/maxAgents (which stay unset unless the spec/caller opts in), runId is
  // always present — call-time only, never a spec field: a run identity is inherently
  // per-invocation.
  const runId = opts.runId ?? crypto.randomUUID();
  resolvedEnv.ALINEO_RUN_ID = runId;
  const resources = { ...config.defaults.resources, ...(spec.resources ?? {}) };

  const credentialBindings = extractCredentialBindings(spec.env ?? {});
  const needsCredentialProxy = credentialBindings.length > 0;
  // `credentialProxy` requires `networkPolicy` to also be set (see SandboxOptions docs). There's
  // no spec-level network-restriction feature yet, so this stays wide open by default — the
  // point here is purely "make injection available for the bound host(s)", not lockdown.
  const networkPolicy = needsCredentialProxy
    ? { defaultAction: "allow" as const, egress: [] }
    : undefined;

  const client = new Sandbox({
    baseUrl: config.serverUrl,
    apiKey: config.apiKey,
    adapter: opts.adapter,
    useServerProxy: config.useServerProxy,
  });

  const store = new AgentSnapshotStore(snapshotsPath(config.adapterPath));
  const setupHash = computeSetupHash(spec);

  const adapter = new PiAdapter();
  let sb: SandboxHandle;
  let fromSnapshot = false;

  // ── Snapshot fast path ────────────────────────────────────────────────────
  if (!opts.rebuild) {
    const record = await store.get(spec.name, setupHash);
    if (record) {
      try {
        console.log(`[agent] restoring from snapshot...`);
        const t1 = Date.now();
        sb = await client.restoreSnapshot(record.snapshotId, spec.name, resources, runId, {
          networkPolicy,
          credentialProxy: needsCredentialProxy,
        });
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
      runId,
      networkPolicy,
      credentialProxy: needsCredentialProxy,
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

  // Applied on every load() (fresh or from-snapshot) — the vault is sidecar-runtime-only, so
  // whichever path just created `sb` needs these re-registered against its own sandboxId.
  for (const { name, value, binding, source } of credentialBindings) {
    await sb!.credentials.set(name, value, binding, source);
  }

  // ── Always: write fresh config + start bridge ─────────────────────────────
  resolvedEnv.ALINEO_SANDBOX_ID = sb!.sandboxId;
  await adapter.configure(sb!, spec, resolvedEnv);

  console.log(`[agent] starting bridge...`);
  const t4 = Date.now();
  await adapter.startBridge(sb!);
  await adapter.waitReady();
  console.log(`[agent] bridge ready    ${elapsed(t4)}`);
  console.log(`[agent] total           ${elapsed(t0)}${fromSnapshot ? " (from snapshot)" : ""}`);

  return { sandbox: sb!, spec, env: resolvedEnv, adapter, fromSnapshot, runId };
}

/**
 * Reconnect to a previously-created agent whose host process has exited. See
 * `Alineo.resume()` for the public-facing docs.
 */
export async function resumeAgent(
  sandboxId: string,
  opts: {
    adapter: IStorageAdapter;
    spec?: AgentSpec | Record<string, unknown>;
    specPath?: string;
    runId?: string;
  },
): Promise<AgentConstructorArgs> {
  const t0 = Date.now();
  const config = await readProjectConfig();

  const client = new Sandbox({
    baseUrl: config.serverUrl,
    apiKey: config.apiKey,
    adapter: opts.adapter,
    useServerProxy: config.useServerProxy,
  });

  // Three-way fallback, in order of preference: an already-parsed object (no I/O at all) >
  // an explicit path (one read) > guessing the path from the ledger's own record of this
  // sandbox's name (see #184 -- unlike load(), resume() has no spec object to fall back to
  // when the caller genuinely doesn't have one on hand, so this guess stays load-bearing).
  let spec: AgentSpec;
  if (opts.spec) {
    spec = validateAgentSpec(opts.spec);
  } else if (opts.specPath) {
    spec = validateAgentSpec(await Bun.file(opts.specPath).json());
  } else {
    const sessions = await client.sandboxes.list();
    const session = sessions.find((s) => s.sandboxId === sandboxId);
    if (!session)
      throw new Error(
        `No ledger record for sandbox ${sandboxId} — pass opts.spec or opts.specPath explicitly`,
      );
    spec = validateAgentSpec(await Bun.file(`./agents/${session.name}.json`).json());
  }

  const resolvedEnv = resolveEnv(spec.env ?? {});
  if (spec.maxAgents !== undefined) {
    assertValidMaxAgents(spec.maxAgents, "Alineo.resume()");
    resolvedEnv.ALINEO_MAX_AGENTS = String(spec.maxAgents);
  }
  if (spec.spawnDepth !== undefined) {
    assertValidSpawnDepth(spec.spawnDepth, "Alineo.resume()");
    resolvedEnv.ALINEO_SPAWN_DEPTH = String(spec.spawnDepth);
  }
  // Same "recompute, don't preserve" convention as spawnDepth/maxAgents above: a resumed
  // agent that doesn't get an explicit override starts a fresh run identity rather than
  // trying to recover the original invocation's exact value.
  const runId = opts.runId ?? crypto.randomUUID();
  resolvedEnv.ALINEO_RUN_ID = runId;

  console.log(`[agent] reconnecting to ${sandboxId}...`);
  const t1 = Date.now();
  const sb = await client.connect(sandboxId, spec.name, { runId });
  console.log(`[agent] connected       ${elapsed(t1)}`);

  // Kill any stale bridge process before starting a fresh one.
  await sb.exec("pkill -f 'node /alineo-bridge.js' 2>/dev/null; sleep 0.1; true", {
    strict: false,
  });

  const adapter = new PiAdapter();
  resolvedEnv.ALINEO_SANDBOX_ID = sandboxId;
  await adapter.configure(sb, spec, resolvedEnv, { resume: true });

  console.log(`[agent] starting bridge...`);
  const t2 = Date.now();
  await adapter.startBridge(sb);
  await adapter.waitReady();
  console.log(`[agent] bridge ready    ${elapsed(t2)}`);
  console.log(`[agent] total           ${elapsed(t0)}`);

  return { sandbox: sb, spec, env: resolvedEnv, adapter, fromSnapshot: false, runId };
}

/**
 * Connect to an already-running sandbox WITHOUT touching its Pi bridge. See
 * `Alineo.attach()` for the public-facing docs.
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
  const client = new Sandbox({
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
      sandboxId === process.env.ALINEO_SANDBOX_ID
        ? readFileSync("/etc/alineo-env", "utf8")
        : await sb.readFile("/etc/alineo-env");
  } catch {
    envFile = "";
  }
  const env = parseShellExports(envFile);
  // Falls back to a fresh UUID only when attaching to a sandbox created before this
  // field existed — every sandbox created going forward always has ALINEO_RUN_ID baked in.
  const runId = env.ALINEO_RUN_ID ?? crypto.randomUUID();
  const stubSpec: AgentSpec = { name: opts.name, cli: "pi" };
  return {
    sandbox: sb,
    spec: stubSpec,
    env,
    adapter: new PiAdapter(),
    fromSnapshot: false,
    runId,
  };
}

/**
 * Fork `self`'s live sandbox into a brand-new independent sandbox running its
 * own Pi bridge, per `childSpecPath`. See `Alineo.spawn()` for the public-facing docs.
 */
export async function spawnChild(
  self: AgentInternal,
  childSpecPath: string,
  opts: { spawnDepth?: number; maxAgents?: number } = {},
): Promise<AgentConstructorArgs> {
  const parentDepth = resolveParentSpawnDepth(process.env.ALINEO_SPAWN_DEPTH, opts.spawnDepth);
  const parentMax = resolveParentMaxAgents(process.env.ALINEO_MAX_AGENTS, opts.maxAgents);
  if (parentMax !== undefined && parentMax <= 0) {
    throw new Error(`Alineo.spawn() refused: max-agents budget exhausted (0 remaining).`);
  }

  const childSpec = validateAgentSpec(await Bun.file(childSpecPath).json());
  const childEnv = resolveEnv(childSpec.env ?? {});
  childEnv.ALINEO_SPAWN_DEPTH = String(parentDepth - 1);
  if (parentMax !== undefined) childEnv.ALINEO_MAX_AGENTS = String(parentMax - 1);
  // Resolved once and used for both the child's own env AND the fork call's ledger
  // record — read from process.env, not self.env, since this code runs as a real CLI
  // process inside the parent's sandbox (same reasoning as ALINEO_SPAWN_DEPTH above),
  // and passed explicitly to fork() because a freshly-`Alineo.attach()`ed self (the
  // `alineo fork` self-attach case) has no in-memory closure carrying it forward.
  const runId = process.env.ALINEO_RUN_ID ?? crypto.randomUUID();
  childEnv.ALINEO_RUN_ID = runId;

  // Distinct from whatever `self` (the parent) already has bound — `fork()` carries the
  // parent's own bound credentials over on its own; this is for bindings that only exist in
  // the *child's* spec, which `fork()` has no way to know about on its own.
  const childCredentialBindings = extractCredentialBindings(childSpec.env ?? {});

  console.log(`[agent] forking sandbox for spawn (${childSpec.name})...`);
  const t0 = Date.now();
  const forkedSb = await self.sandbox.fork(childSpec.name, runId, {
    credentialProxy: childCredentialBindings.length > 0,
  });
  console.log(`[agent] fork ready      ${elapsed(t0)} (${forkedSb.sandboxId})`);

  for (const { name, value, binding, source } of childCredentialBindings) {
    await forkedSb.credentials.set(name, value, binding, source);
  }

  const adapter = new PiAdapter();
  childEnv.ALINEO_SANDBOX_ID = forkedSb.sandboxId;
  await adapter.configure(forkedSb, childSpec, childEnv);

  console.log(`[agent] starting bridge...`);
  const t1 = Date.now();
  await adapter.startBridge(forkedSb, Object.keys(self.env));
  await adapter.waitReady();
  console.log(`[agent] bridge ready    ${elapsed(t1)}`);

  // The forked sandbox's actual ledger name (auto-generated by fork, not
  // childSpec.name) is what `alineo agents` displays and what future forks
  // would derive a `fork-<name>-<id>` label from — report that as this
  // Alineo's name, not the spec's own.
  const namedChildSpec: AgentSpec = { ...childSpec, name: forkedSb.name };
  return {
    sandbox: forkedSb,
    spec: namedChildSpec,
    env: childEnv,
    adapter,
    fromSnapshot: false,
    runId,
  };
}
