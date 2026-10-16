/**
 * Durable agent — an agent's container is removed, and the agent comes back from its checkpoint.
 *
 * Shows, in order:
 *   1. A Pi agent finishes a turn that writes a file.
 *   2. `takeCheckpoint()` saves the agent's /root (workspace and Pi session file) to disk.
 *      alineod does this for you after every settled turn when the spec sets `"checkpoint": true`.
 *      Here it is called by hand so the steps are visible.
 *   3. The container is removed with `docker rm -f`, as a reboot or a reaper would.
 *   4. `Alineo.resume()` finds the sandbox gone, provisions a fresh one and restores the checkpoint.
 *      `agent.restore` says which turn it restored from, or `null` when it had no checkpoint.
 *   5. The same Pi session continues, and the agent can still read its file.
 *
 * Run:  cd examples/durable-agent && bun start
 * Needs: OpenSandbox running (`bunx alineo-cli init`), Docker, and NVIDIA_API_KEY in your environment.
 */
import { Alineo, checkpointsPath, takeCheckpoint } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const LEDGER = "./.alineo/ledger.db";
const adapter = new SQLiteAdapter(LEDGER);
const rule = (s: string) => console.log(`\n${"─".repeat(72)}\n${s}\n${"─".repeat(72)}`);

const spec = {
  name: "durable-agent",
  harness: "pi" as const,
  harnessVersion: "1.2.0",
  provider: "nvidia",
  model: "nvidia/nemotron-3-super-120b-a12b",
  env: { NVIDIA_API_KEY: "${NVIDIA_API_KEY}" },
  resources: { cpu: "1000m", memory: "2Gi" },
};

async function ask(agent: Alineo, text: string): Promise<string> {
  let out = "";
  for await (const ev of agent.prompt(text)) if (ev.type === "text") out += ev.text;
  return out.trim();
}

rule("1 · a turn that writes a file");
const agent = await Alineo.start(spec, { adapter });
const originalId = agent.sandboxId;
console.log(`sandbox: ${originalId}`);
console.log(
  await ask(
    agent,
    "Use your bash tool to run `mkdir -p /root/work && echo durable > /root/work/note.txt`. " +
      "Then reply with exactly the word WRITTEN.",
  ),
);
const sessionBefore = (await agent.getState()).sessionId;
console.log(`pi session: ${sessionBefore}`);

rule("2 · checkpoint the turn");
const checkpoint = await takeCheckpoint(agent.sandbox, checkpointsPath(LEDGER), { turn: 1 });
console.log(`checkpoint: ${checkpoint.snapshotRef}`);

rule("3 · remove the container (docker rm -f)");
const ids = Bun.spawnSync(["docker", "ps", "-aq", "--filter", `name=${originalId}`])
  .stdout.toString()
  .trim()
  .split("\n")
  .filter(Boolean);
Bun.spawnSync(["docker", "rm", "-f", ...ids]);
console.log(`removed ${ids.length} container(s) for ${originalId}`);

rule("4 · Alineo.resume() restores the agent onto a fresh container");
const restored = await Alineo.resume(originalId, { adapter, spec });
try {
  console.log(`new sandbox:  ${restored.sandboxId}`);
  console.log(`restore:      ${JSON.stringify(restored.restore)}`);

  rule("5 · the same session continues");
  const sessionAfter = (await restored.getState()).sessionId;
  console.log(
    `pi session:   ${sessionAfter} (${sessionAfter === sessionBefore ? "same" : "DIFFERENT"})`,
  );
  console.log(
    await ask(
      restored,
      "Use your bash tool to run `cat /root/work/note.txt`. Reply with exactly what it printed.",
    ),
  );
} finally {
  await restored.close();
}
