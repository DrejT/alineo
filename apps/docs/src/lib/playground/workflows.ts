/**
 * Guided, real end-to-end workflows for the docs playground. Each step's `run()`
 * makes live calls against the sandbox API — create real containers, write real
 * files, stream real command output. Nothing here is simulated.
 *
 * `state` is a scratch object threaded through every step of one run.
 * `state.__cleanup` collects sandbox ids to tear down when the run ends (success,
 * failure, or abort).
 */
import type { PlaygroundClient } from "./client";

export interface StepRuntime {
  client: PlaygroundClient;
  state: Record<string, unknown>;
  /** Append text to the current step's output pane. */
  log: (text: string) => void;
  /** User-editable inputs for this workflow (keyed by `WorkflowInput.key`). */
  input: Record<string, string>;
  signal: AbortSignal;
}

export interface WorkflowStep {
  id: string;
  title: string;
  detail: string;
  run: (rt: StepRuntime) => Promise<void>;
}

export interface WorkflowInput {
  key: string;
  label: string;
  value: string;
  language?: string;
  multiline?: boolean;
}

export interface PlaygroundWorkflow {
  slug: string;
  title: string;
  summary: string;
  primitives: string[];
  estimate: string;
  /** Needs a model API key configured on the backend (agents only). */
  needsModelKey?: boolean;
  inputs?: WorkflowInput[];
  steps: WorkflowStep[];
}

// --- shared helpers ----------------------------------------------------------

function track(rt: StepRuntime, sandboxId: string) {
  const list = (rt.state.__cleanup as string[] | undefined) ?? [];
  list.push(sandboxId);
  rt.state.__cleanup = list;
}

/** Stream one command into the step log; return its exit code. */
export async function run(
  rt: StepRuntime,
  sandboxId: string,
  command: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  rt.log(`$ ${command}\n`);
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  for await (const frame of rt.client.exec(sandboxId, command, rt.signal)) {
    if (frame.type === "stdout") {
      // execd streams stdout line-by-line with the trailing newline stripped — put it
      // back so multi-line output doesn't run together.
      const line = frame.text.endsWith("\n") ? frame.text : `${frame.text}\n`;
      stdout += line;
      rt.log(line);
    } else if (frame.type === "exit") {
      exitCode = frame.exitCode;
      stderr = frame.stderr;
      if (frame.stderr) rt.log(frame.stderr);
    } else if (frame.type === "error") {
      throw new Error(frame.message);
    }
  }
  rt.log(`\n— exit ${exitCode}\n`);
  return { exitCode, stdout, stderr };
}

/** Run a command to completion without echoing its output — for trivial setup like `mkdir`. */
async function runQuiet(rt: StepRuntime, sandboxId: string, command: string): Promise<number> {
  let exitCode = 0;
  for await (const frame of rt.client.exec(sandboxId, command, rt.signal)) {
    if (frame.type === "exit") exitCode = frame.exitCode;
    else if (frame.type === "error") throw new Error(frame.message);
  }
  return exitCode;
}

async function newSandbox(rt: StepRuntime, key = "sandbox"): Promise<string> {
  const sb = await rt.client.createSandbox();
  rt.state[key] = sb.id;
  track(rt, sb.id);
  rt.log(`Created sandbox ${sb.name}\n  id: ${sb.id}\n`);
  return sb.id;
}

// --- workflow: run untrusted code -----------------------------------------

const UNTRUSTED_SNIPPET = `# This runs in a throwaway container with a CPU + memory cap.
import sys, platform, os

print("python", sys.version.split()[0], "on", platform.machine())
print("cwd files:", os.listdir("."))

# Some actual work: is 2**1279 - 1 prime? (a known Mersenne prime)
def is_probable_prime(n, rounds=8):
    if n < 2: return False
    for p in (2,3,5,7,11,13,17,19,23,29,31):
        if n % p == 0: return n == p
    d, s = n - 1, 0
    while d % 2 == 0: d //= 2; s += 1
    import random
    for _ in range(rounds):
        a = random.randrange(2, n - 1)
        x = pow(a, d, n)
        if x in (1, n - 1): continue
        for _ in range(s - 1):
            x = pow(x, 2, n)
            if x == n - 1: break
        else:
            return False
    return True

m = 2**1279 - 1
print(f"2**1279 - 1 has {len(str(m))} digits; probable prime: {is_probable_prime(m)}")
`;

const runUntrustedCode: PlaygroundWorkflow = {
  slug: "run-untrusted-code",
  title: "Run untrusted code",
  summary:
    "Execute an arbitrary Python snippet in a disposable, resource-capped container and prove it is isolated from everything else.",
  primitives: ["createSandbox", "writeFile", "exec", "deleteSandbox"],
  estimate: "~30s",
  inputs: [
    {
      key: "snippet",
      label: "snippet.py — edit before running",
      value: UNTRUSTED_SNIPPET,
      language: "python",
      multiline: true,
    },
  ],
  steps: [
    {
      id: "create",
      title: "Spin up an isolated sandbox",
      detail: "A fresh node:22 container with a hard CPU + memory cap and an auto-expiry.",
      run: async (rt) => {
        await newSandbox(rt);
      },
    },
    {
      id: "write",
      title: "Drop the untrusted snippet in",
      detail: "Whatever is in the editor above is written verbatim to /work/snippet.py.",
      run: async (rt) => {
        const id = rt.state.sandbox as string;
        await runQuiet(rt, id, "mkdir -p /work");
        await rt.client.writeFile(id, "/work/snippet.py", rt.input.snippet ?? UNTRUSTED_SNIPPET);
        rt.log("Wrote /work/snippet.py\n");
        const { content } = await rt.client.readFile(id, "/work/snippet.py");
        rt.log(`\nRead back (${content.length} bytes):\n`);
        rt.log(content.split("\n").slice(0, 4).join("\n") + "\n  …\n");
      },
    },
    {
      id: "exec",
      title: "Run it, bounded by a timeout",
      detail: "python3 under `timeout 20` — a hang or fork bomb can't outlive the step.",
      run: async (rt) => {
        const id = rt.state.sandbox as string;
        const { exitCode } = await run(rt, id, "cd /work && timeout 20 python3 snippet.py");
        if (exitCode === 124) rt.log("\n(timed out — killed by `timeout`)\n");
      },
    },
    {
      id: "isolation",
      title: "Prove the isolation",
      detail:
        "Separate hostname, separate filesystem, unprivileged-by-default — nothing here can see the host or another sandbox.",
      run: async (rt) => {
        const id = rt.state.sandbox as string;
        await run(
          rt,
          id,
          "echo hostname=$(cat /etc/hostname); echo user=$(whoami); echo '--- / ---'; ls -1 /",
        );
      },
    },
    {
      id: "destroy",
      title: "Destroy it",
      detail: "The container and its filesystem are gone. Nothing persists.",
      run: async (rt) => {
        const id = rt.state.sandbox as string;
        await rt.client.deleteSandbox(id);
        rt.state.__cleanup = [];
        rt.log(`Deleted sandbox ${id}\n`);
      },
    },
  ],
};

// --- workflow: CI test runner --------------------------------------------

const BUGGY_SUM = `// intentionally wrong: subtracts instead of adds
export function sum(a, b) {
  return a - b;
}
`;

const FIXED_SUM = `export function sum(a, b) {
  return a + b;
}
`;

const SUM_TEST = `import { test } from "node:test";
import assert from "node:assert";
import { sum } from "./sum.js";

test("adds two positives", () => assert.equal(sum(2, 3), 5));
test("adds negatives", () => assert.equal(sum(-4, -6), -10));
test("identity", () => assert.equal(sum(0, 41), 41));
`;

function parseNodeTest(output: string) {
  const pass = Number(/# pass (\d+)/.exec(output)?.[1] ?? 0);
  const fail = Number(/# fail (\d+)/.exec(output)?.[1] ?? 0);
  const total = Number(/# tests (\d+)/.exec(output)?.[1] ?? 0);
  return { pass, fail, total };
}

const ciTestRunner: PlaygroundWorkflow = {
  slug: "ci-test-runner",
  title: "CI test runner",
  summary:
    "Run a project's test suite in a disposable sandbox, watch it fail, apply a fix, watch it pass — and turn the raw output into a structured report.",
  primitives: ["createSandbox", "writeFile", "exec", "deleteSandbox"],
  estimate: "~40s",
  inputs: [
    {
      key: "fix",
      label: "The fix that gets applied in step 4 (sum.js)",
      value: FIXED_SUM,
      language: "javascript",
      multiline: true,
    },
  ],
  steps: [
    {
      id: "create",
      title: "Create the sandbox",
      detail: "node:22 — `node --test` needs nothing else installed.",
      run: async (rt) => {
        await newSandbox(rt);
      },
    },
    {
      id: "scaffold",
      title: "Write the project (with a planted bug)",
      detail: "sum.js subtracts instead of adds; sum.test.js has three assertions.",
      run: async (rt) => {
        const id = rt.state.sandbox as string;
        await runQuiet(rt, id, "mkdir -p /proj");
        await rt.client.writeFile(id, "/proj/package.json", '{ "type": "module" }\n');
        await rt.client.writeFile(id, "/proj/sum.js", BUGGY_SUM);
        await rt.client.writeFile(id, "/proj/sum.test.js", SUM_TEST);
        rt.log("Wrote package.json, sum.js, sum.test.js\n");
      },
    },
    {
      id: "red",
      title: "Run the suite — expect red",
      detail: "One of the three tests should fail against the buggy implementation.",
      run: async (rt) => {
        const id = rt.state.sandbox as string;
        const { stdout } = await run(rt, id, "cd /proj && node --test sum.test.js 2>&1 || true");
        const r = parseNodeTest(stdout);
        rt.state.before = r;
        rt.log(`\nParsed: ${r.pass}/${r.total} passing, ${r.fail} failing\n`);
        if (r.fail === 0) throw new Error("expected at least one failing test");
      },
    },
    {
      id: "fix",
      title: "Apply the fix",
      detail: "Overwrite sum.js with the corrected version from the editor above.",
      run: async (rt) => {
        const id = rt.state.sandbox as string;
        await rt.client.writeFile(id, "/proj/sum.js", rt.input.fix ?? FIXED_SUM);
        rt.log("Patched /proj/sum.js\n");
      },
    },
    {
      id: "green",
      title: "Re-run — expect green",
      detail: "All three assertions should pass now.",
      run: async (rt) => {
        const id = rt.state.sandbox as string;
        const { stdout } = await run(rt, id, "cd /proj && node --test sum.test.js 2>&1 || true");
        const r = parseNodeTest(stdout);
        rt.state.after = r;
      },
    },
    {
      id: "report",
      title: "Structured report",
      detail: "The before/after the CI job would actually post back.",
      run: async (rt) => {
        const before = rt.state.before as { pass: number; fail: number; total: number };
        const after = rt.state.after as { pass: number; fail: number; total: number };
        const report = {
          suite: "sum.test.js",
          before: { ...before, status: before.fail ? "FAIL" : "PASS" },
          after: { ...after, status: after.fail ? "FAIL" : "PASS" },
          fixed: before.fail > 0 && after.fail === 0,
        };
        rt.log(JSON.stringify(report, null, 2) + "\n");
        const id = rt.state.sandbox as string;
        await rt.client.deleteSandbox(id);
        rt.state.__cleanup = [];
        rt.log(`\nDeleted sandbox ${id}\n`);
      },
    },
  ],
};

// --- workflow: checkpoint & resume --------------------------------------

const etlPipeline: PlaygroundWorkflow = {
  slug: "checkpoint-and-resume",
  title: "Checkpoint a multi-stage pipeline",
  summary:
    "Run an extract → transform → load pipeline that snapshots the container after every stage, so a crash resumes from the last good state instead of the top.",
  primitives: ["createSandbox", "exec", "checkpoint", "listCheckpoints"],
  estimate: "~50s",
  steps: [
    {
      id: "create",
      title: "Create the sandbox",
      detail: "One container carries the whole pipeline; each stage writes to /data.",
      run: async (rt) => {
        const id = await newSandbox(rt);
        await run(rt, id, "mkdir -p /data && echo ready");
      },
    },
    {
      id: "extract",
      title: "Stage 1 — extract",
      detail: "Generate 5,000 rows of raw input into /data/raw.jsonl.",
      run: async (rt) => {
        const id = rt.state.sandbox as string;
        await run(
          rt,
          id,
          `node -e "const fs=require('fs');const w=fs.createWriteStream('/data/raw.jsonl');for(let i=0;i<5000;i++)w.write(JSON.stringify({id:i,v:Math.floor(Math.random()*1000)})+'\\n');w.end();" && wc -l /data/raw.jsonl`,
        );
      },
    },
    {
      id: "cp1",
      title: "Checkpoint after extract",
      detail: "sb.checkpoint() — a restorable snapshot of the filesystem right now.",
      run: async (rt) => {
        const id = rt.state.sandbox as string;
        const { snapshotId } = await rt.client.createCheckpoint(id);
        rt.log(`snapshot: ${snapshotId}\n`);
      },
    },
    {
      id: "transform",
      title: "Stage 2 — transform",
      detail: "Bucket + sum the rows into /data/agg.json.",
      run: async (rt) => {
        const id = rt.state.sandbox as string;
        await run(
          rt,
          id,
          `node -e "const fs=require('fs');const rows=fs.readFileSync('/data/raw.jsonl','utf8').trim().split('\\n').map(JSON.parse);const b={};for(const r of rows){const k=Math.floor(r.v/100);b[k]=(b[k]||0)+1;}fs.writeFileSync('/data/agg.json',JSON.stringify(b,null,2));" && cat /data/agg.json`,
        );
      },
    },
    {
      id: "cp2",
      title: "Checkpoint after transform",
      detail: "Second snapshot — the transform never has to re-run after this.",
      run: async (rt) => {
        const id = rt.state.sandbox as string;
        const { snapshotId } = await rt.client.createCheckpoint(id);
        rt.log(`snapshot: ${snapshotId}\n`);
      },
    },
    {
      id: "load",
      title: "Stage 3 — load",
      detail: "Write the final artifact.",
      run: async (rt) => {
        const id = rt.state.sandbox as string;
        await run(
          rt,
          id,
          "cp /data/agg.json /data/loaded.json && echo 'loaded at' $(date -u +%FT%TZ) | tee /data/DONE",
        );
      },
    },
    {
      id: "list",
      title: "The checkpoint chain",
      detail:
        "Every snapshot the pipeline left behind. Sandbox.resume(id) picks up from the newest; earlier execs replay from the ledger instead of re-running.",
      run: async (rt) => {
        const id = rt.state.sandbox as string;
        const { checkpoints } = await rt.client.listCheckpoints(id);
        rt.log(JSON.stringify(checkpoints, null, 2) + "\n");
        await rt.client.deleteSandbox(id);
        rt.state.__cleanup = [];
        rt.log(`\nDeleted sandbox ${id}\n`);
      },
    },
  ],
};

// --- workflow: fork a sandbox ------------------------------------------

const forkSandbox: PlaygroundWorkflow = {
  slug: "fork-a-sandbox",
  title: "Fork a sandbox for parallel work",
  summary:
    "Do the expensive setup once, then fork the live container into independent children that share that state but can't see each other's changes.",
  primitives: ["createSandbox", "exec", "fork", "deleteSandbox"],
  estimate: "~1 min",
  steps: [
    {
      id: "create",
      title: "Create the base sandbox",
      detail: "This is the one that pays the setup cost.",
      run: async (rt) => {
        await newSandbox(rt, "base");
      },
    },
    {
      id: "setup",
      title: "Expensive one-time setup",
      detail: "Pretend this is `npm ci`. We write a shared baseline both children inherit.",
      run: async (rt) => {
        const id = rt.state.base as string;
        await run(
          rt,
          id,
          "mkdir -p /work && echo 'shared baseline built once' > /work/base.txt && sleep 1 && cat /work/base.txt",
        );
      },
    },
    {
      id: "forkA",
      title: "Fork → child A",
      detail: "sb.fork() — a full copy of the base container's filesystem, running independently.",
      run: async (rt) => {
        const base = rt.state.base as string;
        const child = await rt.client.forkSandbox(base, "child-a");
        rt.state.childA = child.id;
        track(rt, child.id);
        rt.log(`forked A: ${child.name} (${child.id})\n`);
        await run(rt, child.id, "echo 'A was here' >> /work/base.txt && cat /work/base.txt");
      },
    },
    {
      id: "forkB",
      title: "Fork → child B",
      detail: "A second fork from the same base. It has the baseline but not A's changes.",
      run: async (rt) => {
        const base = rt.state.base as string;
        const child = await rt.client.forkSandbox(base, "child-b");
        rt.state.childB = child.id;
        track(rt, child.id);
        rt.log(`forked B: ${child.name} (${child.id})\n`);
        await run(rt, child.id, "echo 'B was here' >> /work/base.txt && cat /work/base.txt");
      },
    },
    {
      id: "prove",
      title: "The children are independent",
      detail: "A's file has only A's line; B's has only B's. Neither leaked into the other.",
      run: async (rt) => {
        const a = rt.state.childA as string;
        const b = rt.state.childB as string;
        rt.log("--- child A: /work/base.txt ---\n");
        await run(rt, a, "cat /work/base.txt");
        rt.log("\n--- child B: /work/base.txt ---\n");
        await run(rt, b, "cat /work/base.txt");
      },
    },
    {
      id: "destroy",
      title: "Tear down all three",
      detail: "Base + both forks.",
      run: async (rt) => {
        for (const key of ["childA", "childB", "base"] as const) {
          const id = rt.state[key] as string | undefined;
          if (!id) continue;
          await rt.client.deleteSandbox(id).catch(() => {});
          rt.log(`deleted ${id}\n`);
        }
        rt.state.__cleanup = [];
      },
    },
  ],
};

// --- workflow: agent bugfix -------------------------------------------

const agentBugfix: PlaygroundWorkflow = {
  slug: "agent-bugfix",
  title: "Let an agent fix a failing test",
  summary:
    "Load a Pi coding agent into a sandbox, hand it a repo with a failing test, and stream every tool call as it debugs, patches, and re-runs the suite until it's green.",
  primitives: ["createAgent", "prompt (stream)", "deleteAgent"],
  estimate: "~2 min",
  needsModelKey: true,
  inputs: [
    {
      key: "task",
      label: "Task for the agent",
      value:
        "In /work there's fib.py (a broken iterative Fibonacci) and test_fib.py. Run `python3 test_fib.py`, work out why it fails, fix fib.py, and re-run until it prints PASS. Then print fib(15).",
      multiline: true,
    },
  ],
  steps: [
    {
      id: "create",
      title: "Load the agent",
      detail: "python-data spec: a Pi agent on node:22 with Python 3. Boots its own sandbox.",
      run: async (rt) => {
        const agent = await rt.client.createAgent("python-data");
        rt.state.agent = agent.id;
        track(rt, agent.id);
        rt.log(`agent ${agent.name} ready (sandbox ${agent.id})\n`);
      },
    },
    {
      id: "seed",
      title: "Plant the failing repo",
      detail: "A buggy iterative fib() plus a plain-python test that catches it.",
      run: async (rt) => {
        const id = rt.state.agent as string;
        await runQuiet(rt, id, "mkdir -p /work");
        await rt.client.writeFile(
          id,
          "/work/fib.py",
          "def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a  # bug: forgot to advance the sum\n    return a\n",
        );
        await rt.client.writeFile(
          id,
          "/work/test_fib.py",
          'from fib import fib\n\nexpected = [0, 1, 1, 2, 3, 5, 8, 13]\ngot = [fib(i) for i in range(len(expected))]\nassert got == expected, f"expected {expected}, got {got}"\nprint("PASS")\n',
        );
        rt.log("wrote /work/fib.py (buggy) and /work/test_fib.py\n");
      },
    },
    {
      id: "prompt",
      title: "Hand it to the agent",
      detail: "Streams text + every tool_start / tool_end until the agent stops.",
      run: async (rt) => {
        const id = rt.state.agent as string;
        await streamAgentPrompt(rt, id, rt.input.task ?? "");
      },
    },
    {
      id: "verify",
      title: "Independently verify",
      detail: "Don't trust the agent's word — run the suite ourselves.",
      run: async (rt) => {
        const id = rt.state.agent as string;
        await run(rt, id, "cd /work && python3 test_fib.py 2>&1 || true");
        await run(
          rt,
          id,
          "cd /work && python3 -c \"from fib import fib; print('fib(15) =', fib(15))\"",
        );
      },
    },
    {
      id: "destroy",
      title: "Close the agent",
      detail: "Ends the Pi session and deletes its sandbox.",
      run: async (rt) => {
        const id = rt.state.agent as string;
        await rt.client.deleteAgent(id);
        rt.state.__cleanup = [];
        rt.log(`closed agent ${id}\n`);
      },
    },
  ],
};

/**
 * Open the chat WS, send one prompt, stream events into the log until `agent_end`.
 * Permission requests are auto-approved once each — the agent only has its own
 * capped, disposable sandbox to act in.
 */
async function streamAgentPrompt(rt: StepRuntime, agentId: string, task: string): Promise<void> {
  const url = rt.client.chatSocketUrl(agentId);
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      fn();
    };
    rt.signal.addEventListener("abort", () => finish(() => reject(new Error("aborted"))));

    ws.onopen = () => {
      rt.log(`→ ${task}\n\n`);
      ws.send(JSON.stringify({ type: "prompt", text: task }));
    };
    ws.onerror = () => finish(() => reject(new Error(`WebSocket error against ${url}`)));
    ws.onclose = () => finish(() => resolve());
    ws.onmessage = (ev) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(typeof ev.data === "string" ? ev.data : "") as Record<string, unknown>;
      } catch {
        return;
      }
      switch (event.type) {
        case "text":
          rt.log(String(event.text ?? ""));
          break;
        case "tool_start":
          rt.log(`\n  ⚙ ${String(event.toolName)} ${JSON.stringify(event.args ?? {})}\n`);
          break;
        case "tool_end":
          rt.log(`  ${event.isError ? "✗" : "✓"} ${String(event.toolName)}\n`);
          break;
        case "permission_request":
          rt.log(`  · auto-approving ${String(event.tool)}: ${String(event.title ?? "")}\n`);
          ws.send(
            JSON.stringify({
              type: "resolvePermission",
              requestId: event.requestId,
              decision: { kind: "once" },
            }),
          );
          break;
        case "agent_end":
          rt.log("\n");
          finish(() => resolve());
          break;
        case "bridge_error":
          finish(() => reject(new Error(String(event.message))));
          break;
      }
    };
  });
}

export const WORKFLOWS: PlaygroundWorkflow[] = [
  runUntrustedCode,
  ciTestRunner,
  etlPipeline,
  forkSandbox,
  agentBugfix,
];

export function getWorkflow(slug: string): PlaygroundWorkflow | undefined {
  return WORKFLOWS.find((w) => w.slug === slug);
}
