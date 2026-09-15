/**
 * Live checks for research/subtree-controls.md §4 (V1–V3), run against a real OpenSandbox.
 *
 *   V1  can a sandbox be forked while it's paused? (raw Sandbox.fork, then Alineo.spawn)
 *   V2  when prompt()'s inactivity timeout fires, does Pi's turn keep going?
 *       (a) a silent tool call longer than the timeout, (b) the bridge still takes a new
 *       prompt afterwards, (c) a pause longer than the timeout in the middle of a turn
 *   V3  can a sandbox reach an HTTP server on the host (alineod on :4600)?
 *
 * Usage (on the OpenSandbox host):
 *   set -a; . ~/alineo/.env; set +a
 *   ALINEO_ROOT=~/alineo bun apps/alineod/scripts/verify-subtree-assumptions.ts [v1,v2,v3]
 *
 * Imports the SDK from ALINEO_ROOT's build so it can run from a checkout without its own install.
 * Writes every observation to ./verify-subtree-results.json.
 */
import { writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(process.env.ALINEO_ROOT ?? `${process.env.HOME}/alineo`);
const { Alineo } = await import(join(ROOT, "packages/agent/dist/index.mjs"));
const { SQLiteAdapter } = await import(join(ROOT, "packages/adapters/sqlite/dist/index.mjs"));

const only = new Set((process.argv[2] ?? "v1,v2,v3").split(","));
const OUT = resolve("verify-subtree-results.json");
const results: Record<string, unknown> = { startedAt: new Date().toISOString() };
const save = () => writeFileSync(OUT, JSON.stringify(results, null, 2));

const adapter = new SQLiteAdapter(resolve("verify-subtree-ledger.db"));
await adapter.connect?.();

const MODEL = process.env.VERIFY_MODEL ?? "nvidia/nemotron-3.5-lightning-30b-a3b";
function spec(name: string) {
  return {
    name,
    cli: "pi",
    provider: "nvidia",
    model: MODEL,
    env: { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" },
    resources: { cpu: "1000m", memory: "2Gi" },
  };
}

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[verify +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${what}`)), ms)),
  ]);
}

function inspect(sandboxId: string): string {
  const r = Bun.spawnSync([
    "docker", "inspect", "-f",
    "status={{.State.Status}} paused={{.State.Paused}} runtime={{.HostConfig.Runtime}} network={{.HostConfig.NetworkMode}}",
    `sandbox-${sandboxId}`,
  ]);
  return (r.stdout.toString() + r.stderr.toString()).trim();
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; value?: T; error?: string }> {
  const s = Date.now();
  try {
    return { ok: true, ms: Date.now() - s, value: await fn() };
  } catch (e) {
    return { ok: false, ms: Date.now() - s, error: errMsg(e) };
  }
}

const opened: { close(): Promise<void> }[] = [];
async function closeAll() {
  for (const h of opened.reverse()) await h.close().catch(() => {});
}

// ── V1 + V3 share one parent ────────────────────────────────────────────────

async function v1v3() {
  log("V1/V3: loading parent agent");
  const parent = await Alineo.load(spec("verify-v1-parent"), { adapter, spawnDepth: 3, maxAgents: 5 });
  opened.push(parent);
  await parent.sandbox.writeFile("/tmp/v1-marker.txt", "v1-marker-before-pause");
  const pid = parent.sandboxId;
  const v1: Record<string, unknown> = { parentSandboxId: pid, beforePause: inspect(pid) };
  results.v1 = v1;

  if (only.has("v1")) {
    await parent.sandbox.pause();
    v1.afterPause = inspect(pid);
    log("V1: parent paused:", v1.afterPause);

    // 1a — substrate fork of a paused sandbox
    const rawFork = await timed(() => withTimeout(parent.sandbox.fork("v1-paused"), 300_000, "sandbox.fork"));
    v1.rawFork = { ok: rawFork.ok, ms: rawFork.ms, error: rawFork.error };
    if (rawFork.ok && rawFork.value) {
      const f = rawFork.value as { id?: string; sandboxId?: string; exec(c: string): Promise<{ stdout: string }>; close(): Promise<void> };
      opened.push(f);
      const fid = f.sandboxId ?? f.id ?? "?";
      v1.rawForkChild = { sandboxId: fid, inspect: inspect(fid) };
      v1.rawForkMarker = await timed(async () => (await f.exec("cat /tmp/v1-marker.txt")).stdout.trim());
    }
    v1.parentAfterRawFork = inspect(pid);
    log("V1: raw fork:", JSON.stringify(v1.rawFork));
    save();

    // 1b — the path alineod actually uses: Alineo.spawn (fork + child bridge start)
    const childSpecPath = resolve("verify-v1-child.json");
    writeFileSync(childSpecPath, JSON.stringify(spec("verify-v1-child")));
    const agentSpawn = await timed(() =>
      withTimeout(parent.spawn(childSpecPath, { spawnDepth: 2, maxAgents: 4 }), 300_000, "Alineo.spawn"),
    );
    v1.agentSpawn = { ok: agentSpawn.ok, ms: agentSpawn.ms, error: agentSpawn.error };
    if (agentSpawn.ok && agentSpawn.value) {
      const child = agentSpawn.value as InstanceType<typeof Alineo>;
      opened.push(child);
      v1.agentSpawnChild = {
        sandboxId: child.sandboxId,
        inspect: inspect(child.sandboxId),
        state: await timed(() => withTimeout(child.getState(), 15_000, "child.getState")),
      };
    }
    v1.parentAfterAgentSpawn = inspect(pid);
    log("V1: agent spawn:", JSON.stringify(v1.agentSpawn));
    save();

    // 1c — parent is healthy after resume
    await parent.sandbox.resume();
    v1.afterResume = inspect(pid);
    v1.parentBridgeAfterResume = await timed(() => withTimeout(parent.getState(), 15_000, "parent.getState"));
    save();
  }

  if (only.has("v3")) {
    const hostIps = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === "IPv4" && !i.internal)
      .map((i) => i!.address);
    const targets = [
      ...hostIps.map((ip) => `http://${ip}:4600/health`),
      "http://host.docker.internal:4600/health",
      "http://172.17.0.1:8080/health",
      "https://integrate.api.nvidia.com/v1/models",
    ];
    const v3: Record<string, unknown> = {
      sandboxId: pid,
      inspect: inspect(pid),
      hostLocal: await timed(async () => (await fetch("http://127.0.0.1:4600/health")).status),
      targets: {},
    };
    results.v3 = v3;

    const net = await timed(async () =>
      (await parent.sandbox.exec(
        "sh -c 'cat /etc/resolv.conf; echo ---route; ip route 2>/dev/null || cat /proc/net/route; echo ---hosts; cat /etc/hosts; echo ---env; env | grep -iE \"proxy|egress\" || true; which curl wget node'",
      )).stdout,
    );
    v3.sandboxNetwork = net;

    for (const url of targets) {
      const js = `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(6000)}).then(r=>r.text().then(t=>console.log("HTTP "+r.status+" "+t.slice(0,80)))).catch(e=>console.log("ERR "+((e.cause&&(e.cause.code||e.cause.message))||e.name+" "+e.message)))`;
      const r = await timed(async () => {
        const out = await parent.sandbox.exec(`node -e '${js}'`);
        return `${out.stdout.trim()} ${out.stderr.trim()}`.trim();
      });
      (v3.targets as Record<string, unknown>)[url] = r.ok ? r.value : `exec failed: ${r.error}`;
      log("V3:", url, "→", (v3.targets as Record<string, unknown>)[url]);
    }
    save();
  }
}

// ── V2 ──────────────────────────────────────────────────────────────────────

interface TurnObs {
  events: { type: string; atMs: number }[];
  threw?: { error: string; atMs: number };
  endedNaturallyAtMs?: number;
}

function drain(agent: InstanceType<typeof Alineo>, prompt: string, timeoutMs: number, startedAt: number): { obs: TurnObs; done: Promise<void> } {
  const obs: TurnObs = { events: [] };
  const done = (async () => {
    try {
      for await (const ev of agent.prompt(prompt, { inactivityTimeoutMs: timeoutMs })) {
        obs.events.push({ type: (ev as { type: string }).type, atMs: Date.now() - startedAt });
      }
      obs.endedNaturallyAtMs = Date.now() - startedAt;
    } catch (e) {
      obs.threw = { error: errMsg(e), atMs: Date.now() - startedAt };
    }
  })();
  return { obs, done };
}

async function pollUntilIdle(agent: InstanceType<typeof Alineo>, startedAt: number, maxMs: number) {
  const samples: { atMs: number; isStreaming?: boolean; messageCount?: number; error?: string }[] = [];
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const st = await withTimeout(agent.getState(), 10_000, "getState");
      samples.push({ atMs: Date.now() - startedAt, isStreaming: st.isStreaming, messageCount: st.messageCount });
      if (!st.isStreaming) break;
    } catch (e) {
      samples.push({ atMs: Date.now() - startedAt, error: errMsg(e) });
    }
    await sleep(5_000);
  }
  return samples;
}

async function v2() {
  log("V2: loading agent");
  const agent = await Alineo.load(spec("verify-v2"), { adapter });
  opened.push(agent);
  const v2: Record<string, unknown> = { sandboxId: agent.sandboxId, model: MODEL };
  results.v2 = v2;

  // 2a — silent tool call (75s) vs a 20s inactivity timeout
  {
    const s = Date.now();
    const { obs, done } = drain(
      agent,
      "Use your bash tool to run exactly this command: sleep 75 && echo SLEPT_OK_7Q\nWhen it finishes, reply with only V2A_DONE followed by the command's output.",
      20_000,
      s,
    );
    await done;
    log("V2a: stream ended:", JSON.stringify(obs.threw ?? { natural: obs.endedNaturallyAtMs }));
    const samples = await pollUntilIdle(agent, s, 240_000);
    const last = await timed(() => agent.getLastAssistantText());
    v2.a_silentToolCall = { obs, stateSamples: samples, lastAssistantText: last, finishedAtMs: Date.now() - s };
    log("V2a: last text:", JSON.stringify(last.value));
    save();
  }

  // 2b — same bridge still accepts a fresh prompt after an abandoned stream
  {
    const s = Date.now();
    const { obs, done } = drain(agent, "Reply with only: PING_OK", 120_000, s);
    await done;
    v2.b_promptAfterTimeout = { obs: { threw: obs.threw, endedNaturallyAtMs: obs.endedNaturallyAtMs, eventCount: obs.events.length }, lastAssistantText: await timed(() => agent.getLastAssistantText()) };
    log("V2b:", JSON.stringify(v2.b_promptAfterTimeout));
    save();
  }

  // 2c — pause 45s (> 20s timeout) during a turn's tool call, then resume
  {
    const s = Date.now();
    const { obs, done } = drain(
      agent,
      "Use your bash tool to run exactly this command: for i in $(seq 1 12); do echo tick $i; sleep 5; done; echo LOOP_OK_3Z\nWhen it finishes, reply with only V2C_DONE followed by the last line of output.",
      20_000,
      s,
    );
    // wait for the tool call to start (or 60s)
    for (let i = 0; i < 60 && !obs.events.some((e) => e.type === "tool_start"); i++) await sleep(1_000);
    const pauseAt = Date.now() - s;
    await agent.sandbox.pause();
    const pausedInspect = inspect(agent.sandboxId);
    log("V2c: paused at", pauseAt, pausedInspect);
    await sleep(45_000);
    await agent.sandbox.resume();
    const resumeAt = Date.now() - s;
    log("V2c: resumed at", resumeAt);
    await done;
    const samples = await pollUntilIdle(agent, s, 240_000);
    v2.c_pauseMidTurn = {
      pauseAtMs: pauseAt,
      resumeAtMs: resumeAt,
      pausedInspect,
      obs,
      stateSamples: samples,
      lastAssistantText: await timed(() => agent.getLastAssistantText()),
      finishedAtMs: Date.now() - s,
    };
    log("V2c: last text:", JSON.stringify((v2.c_pauseMidTurn as { lastAssistantText: unknown }).lastAssistantText));
    save();
  }
}

try {
  if (only.has("v1") || only.has("v3")) await v1v3();
  if (only.has("v2")) await v2();
} catch (e) {
  results.fatal = errMsg(e);
  log("FATAL", errMsg(e));
} finally {
  results.finishedAt = new Date().toISOString();
  save();
  await closeAll();
  log("done →", OUT);
  process.exit(0);
}
