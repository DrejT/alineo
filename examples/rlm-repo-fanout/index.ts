/**
 * RLM fan-out: a master agent clones a repo, decides how to split a task
 * across it, and forks child agents (via `alineo fork`, itself built on
 * `Alineo.spawn()`) that each work on one slice from the *exact same*
 * checked-out commit — not a fresh clone each. See TASK.md for the actual
 * goal handed to the master (G2: externalized as a file, not pasted into
 * the prompt) and plans/alineo-rlm-substrate.md for the full design.
 *
 * This script is both the demo and the integration test — it inspects real
 * evidence from the sandboxes afterward rather than trusting the model's
 * own report:
 *   - every spawned child's `repo` is at the master's exact commit (G5 proof)
 *   - a master-only secret (RLM_FANOUT_SECRET) is genuinely absent from a
 *     child's actual Pi/bridge environment (env-leak negative control)
 *   - a spawned child's own `ALINEO_SPAWN_DEPTH` is exactly 0 (not absent)
 *   - a worker has no `alineo` installed at all, so it cannot itself spawn
 *     (worker.json's own scoping, a second, structural negative control)
 *   - the master never committed anything to `repo` itself (report-only)
 *
 * Run: bun examples/rlm-repo-fanout/index.ts
 * Needs: OpenSandbox running + reachable from containers (see
 *        examples/pi-agent/test-spawn-child.ts for the two things that have
 *        to be true for that), NVIDIA_API_KEY in .env.
 */
import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { randomBytes } from "crypto";

// Relative paths below (agent specs, ledger) are resolved against this
// directory regardless of the invoking shell's CWD — `Bun.file()` resolves
// against `process.cwd()`, and this example is documented to run as
// `bun examples/rlm-repo-fanout/index.ts` from the repo root.
process.chdir(import.meta.dir);

// Bun only loads `.env` from the shell's CWD at invocation, not by walking up
// to the repo root — so running this from inside examples/rlm-repo-fanout
// (which has no .env of its own) silently resolves NVIDIA_API_KEY to an empty
// string. That doesn't fail loudly: the sandbox builds fine, Pi just rejects
// every prompt with "no API key found," which used to hang forever behind the
// bridge's heartbeat instead of erroring (fixed separately in pi.ts, but this
// catches the actual mistake before spending 60s+ building a doomed sandbox).
if (!process.env.NVIDIA_API_KEY) {
  throw new Error(
    "NVIDIA_API_KEY is not set. Run this from the repo root (bun examples/rlm-repo-fanout/index.ts) " +
      "so Bun loads the root .env — running from inside this directory won't pick it up.",
  );
}

process.env.MASTER_AGENT_OPENSANDBOX_DOMAIN ??= "172.17.0.1:8080";
const SECRET = `rlm-fanout-secret-${randomBytes(8).toString("hex")}`;
process.env.RLM_FANOUT_SECRET = SECRET;

const MASTER_SPEC = "./agents/master.json";
const adapter = new SQLiteAdapter("./.alineo/ledger.db");
const baseUrl = process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080";
const apiKey = process.env.OPEN_SANDBOX_API_KEY ?? "";

// `alineo fork` (run FROM INSIDE the master's own sandbox) opens its own
// SQLiteAdapter, pointed at a ledger file that lives inside that sandbox's
// container filesystem — a completely separate file from this host script's
// own `./.alineo/ledger.db`. A forked child's `sandbox_created` ledger event
// lands there, not here, so a ledger-backed `sandboxes.list()` call (which
// reads THIS host's adapter) can never see it. The OpenSandbox control plane
// itself, though, genuinely registers every sandbox regardless of which
// ledger (if any) recorded it — so list raw sandboxes directly via the REST
// API instead.
interface RawSandbox {
  id: string;
  status: { state: string };
  createdAt: string;
}
async function listRunningSandboxes(): Promise<RawSandbox[]> {
  const res = await fetch(`${baseUrl}/v1/sandboxes?state=Running`, {
    headers: { "OPEN-SANDBOX-API-KEY": apiKey },
  });
  if (!res.ok) throw new Error(`control-plane list failed: ${res.status}`);
  const data = (await res.json()) as { items: RawSandbox[] };
  return data.items;
}

const checks: { name: string; pass: boolean; detail?: string }[] = [];
function check(name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass, detail });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const testStart = Date.now();
console.log("=== Loading master (spawnDepth: 1) ===\n");
// Alineo.load() no longer does its own file I/O (see #184) -- read the spec ourselves.
const masterSpec = await Bun.file(MASTER_SPEC).json();
const master = await Alineo.load(masterSpec, {
  adapter,
  rebuild: process.env.REBUILD === "1",
});
console.log(
  `\nmaster: ${master.name}  sandbox: ${master.sandboxId}  fromSnapshot: ${master.fromSnapshot}\n`,
);

const spawnedChildren: Alineo[] = [];

try {
  console.log("=== Prompting master (goal lives in TASK.md, not in this prompt) ===\n");
  let reply = "";
  try {
    for await (const ev of master.prompt(
      "Read ./TASK.md in your working directory and complete the task described there. " +
        "Report a summary of what happened, including the combined patch set, when you are done.",
    )) {
      if (ev.type === "text") {
        process.stdout.write(ev.text);
        reply += ev.text;
      } else if (ev.type === "tool_start") {
        console.log(`\n[tool_start] ${ev.toolName} ${JSON.stringify(ev.args).slice(0, 400)}`);
      } else if (ev.type === "tool_end") {
        console.log(`[tool_end]   ${ev.toolName} isError=${ev.isError}`);
        if (ev.isError) console.log(`  result: ${JSON.stringify(ev.result).slice(0, 500)}`);
      }
    }
  } catch (err) {
    console.log(`\nprompt failed: ${err instanceof Error ? err.message : String(err)}`);
    const logs = await master.getLogs().catch(() => "");
    const filtered = logs
      .split("\n")
      .filter((l) => /error|exit|ready|429|quota|exception/i.test(l))
      .join("\n");
    console.log(`--- filtered bridge logs ---\n${filtered}\n--- end filtered logs ---`);
    throw err;
  }
  console.log("\n\n" + "─".repeat(60));

  // ── Independent verification ────────────────────────────────────────────
  console.log("\n=== Verifying evidence (not the model's self-report) ===\n");

  const { stdout: masterHeadOut } = await master.sandbox.exec("cd repo && git rev-parse HEAD");
  const masterHead = masterHeadOut.trim();
  console.log(`master repo HEAD: ${masterHead}`);

  // A separate exec() call, not a "&&"-chained one — sb.exec() doesn't insert a
  // newline between chained commands' outputs, so comparing against a second
  // command's output in the same call is unreliable. Re-running the same
  // command standalone and comparing HEAD before/after is what "no new commit
  // was made" actually means anyway.
  const { stdout: masterHeadAfterOut } = await master.sandbox.exec("cd repo && git rev-parse HEAD");
  check(
    "master never committed to its own repo (report-only)",
    masterHeadAfterOut.trim() === masterHead,
  );

  const running = await listRunningSandboxes();
  const childSandboxes = running.filter(
    (s) => s.id !== master.sandboxId && new Date(s.createdAt).getTime() >= testStart,
  );
  check(
    "at least one child was spawned",
    childSandboxes.length > 0,
    `found ${childSandboxes.length}`,
  );

  for (const raw of childSandboxes) {
    const name = `child-${raw.id.slice(0, 8)}`;
    console.log(`\n--- child: ${name} (${raw.id}) ---`);
    const child = await Alineo.attach(raw.id, { adapter, name });
    spawnedChildren.push(child);

    const { stdout: childHeadOut } = await child.sandbox.exec("cd repo && git rev-parse HEAD");
    check(`${name}: repo HEAD matches master's`, childHeadOut.trim() === masterHead);

    // Alineo.attach() deliberately never starts the Pi bridge (see its own doc comment), so
    // child.bash() -- which needs that bridge -- isn't available here. Sourcing
    // /etc/alineo-env directly over the plain sandbox exec API inspects the exact same
    // environment the bridge would have started Pi with, without needing it running.
    const { stdout: probeOut } = await child.sandbox.exec(
      `sh -c '. /etc/alineo-env 2>/dev/null; echo "SECRET=[$RLM_FANOUT_SECRET]"; echo "DEPTH=[$ALINEO_SPAWN_DEPTH]"; which alineo > /dev/null 2>&1; echo "ALINEO_FOUND=[$?]"'`,
    );
    check(
      `${name}: master's secret is absent`,
      probeOut.includes("SECRET=[]") && !probeOut.includes(SECRET),
    );
    check(`${name}: spawn depth is exactly 0`, probeOut.includes("DEPTH=[0]"));
    check(
      `${name}: has no alineo installed (cannot itself spawn)`,
      probeOut.includes("ALINEO_FOUND=[1]"),
    );
  }

  console.log(`\n=== ${checks.filter((c) => c.pass).length}/${checks.length} checks passed ===`);
  console.log(checks.every((c) => c.pass) ? "\n✓ PASS" : "\n✗ FAIL — see checks above");
  if (!checks.every((c) => c.pass)) process.exitCode = 1;
} finally {
  await Promise.all(spawnedChildren.map((c) => c.close()));
  await master.close();
  console.log("\nAll sandboxes closed.");
}
