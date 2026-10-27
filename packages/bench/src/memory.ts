/**
 * Memory suite: alineod's working memory (key/value per resource) and whether agents can use it.
 *
 * API checks (deterministic, no model): round-trips for several JSON types, the 64 KiB limit, idempotent delete,
 * isolation between resources, sharing within one resource, durability across an alineod restart, and the
 * semantic-facts endpoint (needs an embeddings provider; reported as unavailable if there is none).
 *
 * Agent checks (a real model, checked by code): a fresh agent in a NEW sandbox with the same resource must answer
 * from memory; an updated value must replace the old one; distractor keys must not confuse it; an agent with a
 * DIFFERENT resource must not know the value (any leak is a failure).
 *
 * Usage: bun src/memory.ts [--repeats 2] [--no-restart] [--out results]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentSpec, call, deleteRun, startRun, waitHealthy, waitResult } from "./alineod.ts";
import { assertProviderBudget, ProviderCapReached } from "./budget.ts";
import { collectManifest } from "./manifest.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

interface Check {
  group: "api" | "agent";
  name: string;
  pass: boolean;
  detail?: string;
}
const checks: Check[] = [];
const record = (group: Check["group"], name: string, pass: boolean, detail?: string) => {
  checks.push({ group, name, pass, ...(detail === undefined ? {} : { detail }) });
  console.log(`${pass ? "PASS" : "FAIL"} [${group}] ${name}${detail ? `  (${detail})` : ""}`);
};

const stamp = Date.now();
const runIds: string[] = [];

/** Start an agent whose memory scope is `resource`; it only needs to exist, so give it a trivial turn. */
async function agentFor(resource: string, prompt = "Reply with exactly: READY") {
  const run = await startRun(
    {
      ...agentSpec({ name: `mem-${resource}-${Math.random().toString(36).slice(2, 6)}` }),
      resourceId: resource,
    },
    prompt,
  );
  runIds.push(run.runId);
  return run;
}

const mem = (agentId: string, key: string) =>
  `/agents/${agentId}/memory/${encodeURIComponent(key)}`;

async function apiChecks(restart: boolean) {
  const A = `bench-a-${stamp}`;
  const B = `bench-b-${stamp}`;
  const a = await agentFor(A);
  const b = await agentFor(B);
  await waitResult(a.rootAgentId, 600_000);
  await waitResult(b.rootAgentId, 600_000);

  // M1 round trips
  const samples: [string, unknown][] = [
    ["str", "hello"],
    ["num", 42.5],
    ["obj", { x: [1, { y: null }], z: "é" }],
    ["arr", [1, 2, 3]],
    ["bool", false],
  ];
  let allRoundTrip = true;
  for (const [k, v] of samples) {
    const put = await call("PUT", mem(a.rootAgentId, k), { value: v });
    const got = await call<{ value: unknown }>("GET", mem(a.rootAgentId, k));
    if (put.status >= 300 || JSON.stringify(got.body?.value) !== JSON.stringify(v))
      allRoundTrip = false;
  }
  record("api", "JSON values round-trip (string, number, object, array, boolean)", allRoundTrip);

  // M2 size limit
  const big = await call("PUT", mem(a.rootAgentId, "big"), { value: "x".repeat(70_000) });
  record(
    "api",
    "a value over 64 KiB is rejected",
    big.status >= 400 && big.status < 500,
    `HTTP ${big.status}`,
  );

  // M3 delete is idempotent
  await call("PUT", mem(a.rootAgentId, "tmp"), { value: 1 });
  const d1 = await call("DELETE", mem(a.rootAgentId, "tmp"));
  const d2 = await call("DELETE", mem(a.rootAgentId, "tmp"));
  const gone = await call("GET", mem(a.rootAgentId, "tmp"));
  record(
    "api",
    "delete is idempotent and the key is gone",
    d1.status < 300 && d2.status < 300 && gone.status === 404,
    `${d1.status}/${d2.status}/${gone.status}`,
  );

  // M4 isolation between resources
  await call("PUT", mem(a.rootAgentId, "secret"), { value: "ALPHA-ONLY" });
  const leak = await call<{ value?: unknown }>("GET", mem(b.rootAgentId, "secret"));
  const list = await call<
    { working?: Record<string, unknown>; keys?: string[] } & Record<string, unknown>
  >("GET", `/agents/${b.rootAgentId}/memory`);
  const leaked =
    JSON.stringify(list.body ?? {}).includes("ALPHA-ONLY") ||
    JSON.stringify(leak.body ?? {}).includes("ALPHA-ONLY");
  record(
    "api",
    "a different resource cannot read the value (no leak)",
    leak.status === 404 && !leaked,
    `GET other resource -> ${leak.status}`,
  );

  // M5 sharing inside one resource (a second agent with the same resourceId)
  const a2 = await agentFor(A);
  await waitResult(a2.rootAgentId, 600_000);
  const shared = await call<{ value: unknown }>("GET", mem(a2.rootAgentId, "secret"));
  record(
    "api",
    "a second agent with the same resource sees the value",
    shared.status === 200 && shared.body?.value === "ALPHA-ONLY",
    `HTTP ${shared.status}`,
  );

  // M6 durability across an alineod restart
  if (restart) {
    const c = process.env.ALINEOD_CONTAINER ?? "alineo-alineod";
    execFileSync("docker", ["restart", c], { stdio: "ignore", timeout: 420_000 });
    await waitHealthy();
    const after = await call<{ value: unknown }>("GET", mem(a2.rootAgentId, "secret"));
    record(
      "api",
      "the value survives an alineod restart",
      after.status === 200 && after.body?.value === "ALPHA-ONLY",
      `HTTP ${after.status}`,
    );
  }

  // M7 semantic facts (needs an embeddings provider)
  const fact = await call("POST", `/agents/${a.rootAgentId}/facts`, {
    content: "The user's favourite number is 7.",
  });
  record(
    "api",
    "semantic facts endpoint",
    fact.status < 300,
    fact.status === 501 || fact.status === 502
      ? `unavailable in this setup (HTTP ${fact.status}: no embeddings provider)`
      : `HTTP ${fact.status}`,
  );
  return { A, B, a };
}

async function ask(resource: string, question: string): Promise<string> {
  await assertProviderBudget();
  const run = await agentFor(resource, `${question} Reply with only the answer, nothing else.`);
  const res = await waitResult(run.rootAgentId, 600_000);
  return res.outcome === "success" ? (res.result ?? "") : `(turn ${res.outcome})`;
}

async function agentChecks(
  ctx: { A: string; B: string; a: { rootAgentId: string } },
  repeats: number,
) {
  const id = ctx.a.rootAgentId;
  // Plant distinct facts, plus near-duplicate and stale values as distractors.
  const plant: Record<string, unknown> = {
    pet: "Biscuit",
    city: "Lisbon",
    color: "teal",
    pet_old: "Rex",
    city_previous: "Porto",
  };
  for (let i = 0; i < 12; i++) plant[`note_${i}`] = `filler value ${i}`;
  for (const [k, v] of Object.entries(plant)) await call("PUT", mem(id, k), { value: v });

  const tally = { recall: [0, 0], distractor: [0, 0], update: [0, 0], isolation: [0, 0] };
  for (let r = 0; r < repeats; r++) {
    const pet = await ask(ctx.A, "What is the name of my pet, according to your memory?");
    tally.recall[1]++;
    if (/biscuit/i.test(pet)) tally.recall[0]++;
    else console.log(`   recall miss: ${JSON.stringify(pet.slice(0, 80))}`);

    const city = await ask(
      ctx.A,
      "Which city do I live in now, according to your memory? (Not a previous one.)",
    );
    tally.distractor[1]++;
    if (/lisbon/i.test(city) && !/porto/i.test(city)) tally.distractor[0]++;
    else console.log(`   distractor miss: ${JSON.stringify(city.slice(0, 80))}`);

    const leak = await ask(ctx.B, "What is the name of my pet, according to your memory?");
    tally.isolation[1]++;
    if (!/biscuit|rex/i.test(leak)) tally.isolation[0]++;
    else console.log(`   LEAK: ${JSON.stringify(leak.slice(0, 80))}`);
  }
  // Update: replace the value, a fresh agent must report the new one only.
  await call("PUT", mem(id, "pet"), { value: "Pixel" });
  for (let r = 0; r < repeats; r++) {
    const pet = await ask(ctx.A, "What is the name of my pet, according to your memory?");
    tally.update[1]++;
    if (/pixel/i.test(pet) && !/biscuit/i.test(pet)) tally.update[0]++;
    else console.log(`   update miss: ${JSON.stringify(pet.slice(0, 80))}`);
  }
  record(
    "agent",
    "a fresh agent (new sandbox, same resource) recalls a stored fact",
    tally.recall[0] === tally.recall[1] && tally.recall[1] > 0,
    `${tally.recall[0]}/${tally.recall[1]}`,
  );
  record(
    "agent",
    "it picks the right key among near-duplicates and stale values",
    tally.distractor[0] === tally.distractor[1] && tally.distractor[1] > 0,
    `${tally.distractor[0]}/${tally.distractor[1]}`,
  );
  record(
    "agent",
    "after an update it reports the new value, not the old one",
    tally.update[0] === tally.update[1] && tally.update[1] > 0,
    `${tally.update[0]}/${tally.update[1]}`,
  );
  record(
    "agent",
    "an agent with a different resource does not know the value (no leak)",
    tally.isolation[0] === tally.isolation[1] && tally.isolation[1] > 0,
    `${tally.isolation[0]}/${tally.isolation[1]}`,
  );
  return tally;
}

const manifest = collectManifest({
  scenario: "memory",
  model: process.env.BENCH_AGENT_MODEL ?? "openai/gpt-oss-20b",
});
let stoppedEarly: string | undefined;
let tally: unknown = null;
try {
  const ctx = await apiChecks(!process.argv.includes("--no-restart"));
  if (!process.argv.includes("--api-only"))
    tally = await agentChecks(ctx, Number(arg("repeats", "2")));
} catch (e) {
  if (e instanceof ProviderCapReached) stoppedEarly = e.message;
  else
    record(
      "api",
      "suite ran without an unexpected error",
      false,
      e instanceof Error ? e.message : String(e),
    );
} finally {
  for (const id of runIds) await deleteRun(id);
}
const dir = join(arg("out", "results"), `memory-${manifest.runId}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(
  join(dir, "result.json"),
  JSON.stringify({ checks, tally, stoppedEarly: stoppedEarly ?? null }, null, 2),
);
const ok = checks.filter((c) => c.pass).length;
console.log(`\nmemory: ${ok}/${checks.length} checks passed`);
if (stoppedEarly) console.log(`STOPPED EARLY: ${stoppedEarly}`);
console.log(`wrote ${dir}`);
