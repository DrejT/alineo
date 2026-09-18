/**
 * Recipe: the same swarm-code-review scenario as ../swarm-code-review, driven entirely through
 * alineo-mcp's tools instead of raw alineod HTTP calls — this is the MCP-client counterpart,
 * useful for comparing the two side by side.
 *
 *   review-lead ── clones expressjs/cors once
 *     ├── reviewer: security      ┐
 *     └── reviewer: correctness   ┘─ forked from the lead's sandbox — the checkout is already there
 *     editor ── waitFor both — merges their findings from /inputs into one report
 *
 * Along the way the operator (this script) pauses/resumes the correctness reviewer and steers
 * the security reviewer onto a narrower brief — without restarting either. Progress streams via
 * repeated alineod_watch_events calls (an MCP tool call is request/response, so it's a bounded
 * poll-and-collect rather than one open SSE connection — see packages/mcp/README.md).
 *
 * Needs alineo-mcp built (bun run --cwd ../../packages/mcp build) and a running alineod with
 * NVIDIA_API_KEY in its environment (see README).
 */
import { writeFileSync } from "node:fs";
import { connectAlineoMcp } from "./mcp-client.ts";

const SERVER_PATH = new URL("../../packages/mcp/dist/index.mjs", import.meta.url).pathname;
const lead = await Bun.file(new URL("./agents/lead.json", import.meta.url)).json();
const reviewer = await Bun.file(new URL("./agents/reviewer.json", import.meta.url)).json();
const editor = await Bun.file(new URL("./agents/editor.json", import.meta.url)).json();

const mcp = await connectAlineoMcp({
  serverPath: SERVER_PATH,
  alineodUrl: process.env.ALINEOD_URL,
});

async function waitLive(agentId: string): Promise<void> {
  for (;;) {
    const agent = await mcp.call("alineod_get_agent", { agentId });
    if (agent.sandboxId) return;
    if (agent.outcome) throw new Error(`${agent.specName} ended before starting: ${agent.outcome}`);
    await Bun.sleep(2_000);
  }
}

async function waitResult(
  agentId: string,
  waitSeconds = 120,
): Promise<{ outcome: string; result: string }> {
  for (;;) {
    const res = await mcp.call("alineod_get_result", { agentId, waitSeconds });
    if (res.state === "settled") return { outcome: res.outcome, result: res.result ?? "" };
  }
}

const labels = new Map<string, string>();
const label = (agentId: string | null) => (agentId && labels.get(agentId)) || "run";

// Polls alineod_watch_events on an interval instead of holding one SSE connection — each call is
// a bounded window (default 20s here) that resumes from the last event id it saw.
async function watch(runId: string, stopSignal: { stopped: boolean }): Promise<void> {
  let sinceEventId = 0;
  while (!stopSignal.stopped) {
    // This loop competes with whatever long-blocked call (e.g. the editor's `waitFor` spawn) is
    // also in flight over the same stdio pipe. mcp-client.ts's default per-call timeout already
    // gives real headroom above the 20s server-side window; treat a timeout as "no events this
    // round" rather than letting an unhandled rejection crash the process.
    let events: unknown[];
    try {
      events = await mcp.call("alineod_watch_events", { runId, sinceEventId, maxWaitSeconds: 20 });
    } catch {
      continue;
    }
    for (const e of events as { id?: number; event: string; data: any }[]) {
      if (e.id !== undefined) sinceEventId = Math.max(sinceEventId, e.id);
      const d = e.data;
      const who = label(d?.agentId ?? null).padEnd(22);
      if (e.event === "agent_provisioned") console.log(`  ${who} sandbox ready`);
      if (e.event === "agent_state_changed" && d.reason !== "prompt")
        console.log(`  ${who} ${d.from} → ${d.to} (${d.reason})`);
      if (e.event === "agent_steered") console.log(`  ${who} steered`);
      if (e.event === "tool_start") console.log(`  ${who} ${d.toolName}`);
      if (e.event === "budget_denied")
        console.log(`  ${who} spawn refused: ${d.dimension} exhausted`);
      if (e.event === "agent_ended") console.log(`  ${who} done (${d.outcome})`);
    }
  }
}

// ── 1. the lead checks out the repository once ──────────────────────────────

console.log(
  "Starting the review lead via alineod_create_run (first run installs git and clones)...",
);
const run = await mcp.call("alineod_create_run", {
  spec: lead,
  prompt:
    "Run `git -C /workspace/cors log --oneline -1` with your bash tool and reply with only its output.",
});
labels.set(run.rootAgentId, "review-lead");
const stopSignal = { stopped: false };
const watching = watch(run.runId, stopSignal);

await waitLive(run.rootAgentId);
const commit = await waitResult(run.rootAgentId);
console.log(`\nReviewing expressjs/cors at ${commit.result.trim()}\n`);

// ── 2. fork one reviewer per concern via alineod_spawn_agent ────────────────

const concerns = {
  security: "security: origin validation and reflection, credentials handling, header injection",
  correctness: "correctness: option parsing, preflight handling, and edge cases in lib/index.js",
} as const;

const reviewers: Record<string, string> = {};
for (const [key, focus] of Object.entries(concerns)) {
  const child = await mcp.call("alineod_spawn_agent", {
    runId: run.runId,
    parentAgentId: run.rootAgentId,
    spec: { ...reviewer, name: `reviewer-${key}` },
    idempotencyKey: `review-${key}`, // a retried call can't fork a duplicate reviewer
    prompt:
      `You are reviewing the Express CORS middleware checked out at /workspace/cors. ` +
      `Focus only on ${focus}. Read lib/index.js and the tests with your bash tool. ` +
      `Report at most 5 findings as a markdown list — each with file:line and one sentence. ` +
      `Do not modify any files. Output only the list.`,
  });
  reviewers[key] = child.agentId;
  labels.set(child.agentId, `reviewer-${key}`);
}
await Promise.all(Object.values(reviewers).map(waitLive));

// ── 3. intervene while they work, via alineod_pause_agent/resume_agent/steer_agent ──

await mcp.call("alineod_pause_agent", { agentId: reviewers.correctness });
await Bun.sleep(5_000);
await mcp.call("alineod_resume_agent", { agentId: reviewers.correctness });

await mcp.call("alineod_steer_agent", {
  agentId: reviewers.security,
  message:
    "Priority change from the lead: concentrate on what happens when `origin` is `true` or a function " +
    "and `credentials` is enabled. Drop unrelated findings.",
});

// ── 4. the editor waits for both reviewers, then merges ─────────────────────

const areaOf = Object.fromEntries(Object.entries(reviewers).map(([k, id]) => [id, k]));
const final = await mcp.call(
  "alineod_spawn_agent",
  {
    runId: run.runId,
    parentAgentId: run.rootAgentId,
    spec: editor,
    waitFor: Object.values(reviewers),
    idempotencyKey: "editor", // a retried call can't fork a duplicate editor
    prompt:
      `Use your bash tool to run \`cat /inputs.json /inputs/*.txt\` — that's every reviewer's findings ` +
      `in one place. The files map to areas as follows: ${JSON.stringify(areaOf)}. ` +
      `Write one review report in markdown: a title, then a section per area (Security, Correctness), ` +
      `with duplicate findings merged and the most severe first. If a reviewer's outcome is not "success", ` +
      `say that area was not reviewed. Output only the report.`,
  },
  // waitFor blocks the response until both reviewers finish their own model turns, which can
  // easily exceed the MCP client's 60s default request timeout — this call alone needs more room.
  { timeoutMs: 5 * 60_000 },
);
labels.set(final.agentId, "editor");

const report = await waitResult(final.agentId);
stopSignal.stopped = true;
await watching;

// ── 5. results ──────────────────────────────────────────────────────────────

writeFileSync("review.md", report.result);
console.log(`\n${report.result}\n`);
console.log("Written to review.md\n");

const tree = await mcp.call("alineod_get_run", { runId: run.runId });
for (const a of tree.agents) {
  console.log(`${"  ".repeat(a.depth)}${label(a.agentId).padEnd(22)} ${a.outcome ?? a.state}`);
}

await mcp.call("alineod_delete_run", { runId: run.runId });
await mcp.close();
