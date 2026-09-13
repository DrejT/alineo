/**
 * Recipe: a swarm code review, orchestrated through alineod.
 *
 *   review-lead ── clones expressjs/cors once
 *     ├── reviewer: security      ┐
 *     ├── reviewer: correctness   ├─ forked from the lead's sandbox — the checkout is already there
 *     ├── reviewer: tests         ┘
 *     └── editor ── waitFor all three, merges their findings from /inputs into one report
 *
 * Along the way the operator (this script) steers the security reviewer onto a narrower brief
 * and pauses/resumes the tests reviewer — without restarting either. Every agent's progress is
 * streamed from one SSE connection.
 *
 * Needs a running alineod with NVIDIA_API_KEY in its environment (see README).
 */
import { writeFileSync } from "node:fs";

const BASE = process.env.ALINEOD_URL ?? "http://localhost:4600";
const lead = await Bun.file(new URL("./agents/lead.json", import.meta.url)).json();
const reviewer = await Bun.file(new URL("./agents/reviewer.json", import.meta.url)).json();
const editor = await Bun.file(new URL("./agents/editor.json", import.meta.url)).json();

// ── a minimal alineod client ────────────────────────────────────────────────

// oxlint-disable-next-line typescript/no-explicit-any -- a small untyped client for the recipe
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (res.status >= 400)
    throw new Error(`${method} ${path} → ${res.status}: ${parsed?.error ?? text}`);
  return parsed;
}

async function waitLive(agentId: string): Promise<void> {
  for (;;) {
    const agent = await api("GET", `/agents/${agentId}`);
    if (agent.sandboxId) return;
    if (agent.outcome) throw new Error(`${agent.specName} ended before starting: ${agent.outcome}`);
    await Bun.sleep(2_000);
  }
}

async function waitResult(agentId: string): Promise<{ outcome: string; result: string }> {
  for (;;) {
    const res = await fetch(`${BASE}/agents/${agentId}/result?wait=120`);
    const body = await res.json();
    if (res.status === 200) return { outcome: body.outcome, result: body.result ?? "" };
  }
}

const labels = new Map<string, string>();
const label = (agentId: string | null) => (agentId && labels.get(agentId)) || "run";

async function watch(runId: string, signal: AbortSignal): Promise<void> {
  const res = await fetch(`${BASE}/runs/${runId}/events`, { signal });
  if (!res.body) throw new Error(`GET /runs/${runId}/events → ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = frame.match(/^event: (.*)$/m)?.[1];
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (!event || !data) continue;
        const d = JSON.parse(data);
        const who = label(d.agentId).padEnd(22);
        if (event === "agent_provisioned") console.log(`  ${who} sandbox ready`);
        if (event === "agent_state_changed" && d.reason !== "prompt")
          console.log(`  ${who} ${d.from} → ${d.to} (${d.reason})`);
        if (event === "agent_steered") console.log(`  ${who} steered`);
        if (event === "tool_start") console.log(`  ${who} ${d.toolName}`);
        if (event === "budget_denied")
          console.log(`  ${who} spawn refused: ${d.dimension} exhausted`);
        if (event === "agent_ended") console.log(`  ${who} done (${d.outcome})`);
      }
    }
  } catch {
    // aborted once the review is finished
  }
}

// ── 1. the lead checks out the repository once ──────────────────────────────

console.log("Starting the review lead (first run installs git and clones the repo)...");
const run = await api("POST", "/runs", {
  spec: lead,
  prompt:
    "Run `git -C /workspace/cors log --oneline -1` with your bash tool and reply with only its output.",
});
labels.set(run.rootAgentId, "review-lead");
const stop = new AbortController();
const watching = watch(run.runId, stop.signal);

await waitLive(run.rootAgentId);
const commit = await waitResult(run.rootAgentId);
console.log(`\nReviewing expressjs/cors at ${commit.result.trim()}\n`);

// ── 2. fork one reviewer per concern ────────────────────────────────────────

const concerns = {
  security: "security: origin validation and reflection, credentials handling, header injection",
  correctness: "correctness: option parsing, preflight handling, and edge cases in lib/index.js",
  tests: "test coverage: behaviour in lib/index.js that test/ does not exercise",
} as const;

const reviewers: Record<string, string> = {};
for (const [key, focus] of Object.entries(concerns)) {
  const child = await api("POST", `/runs/${run.runId}/agents`, {
    parentAgentId: run.rootAgentId,
    spec: { ...reviewer, name: `reviewer-${key}` },
    idempotencyKey: `review-${key}`, // a retried request can't fork a duplicate reviewer
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

// ── 3. intervene while they work ────────────────────────────────────────────

// Freeze the tests reviewer's container for a moment, then let it carry on exactly where it was.
await api("POST", `/agents/${reviewers.tests}/pause`);
await Bun.sleep(5_000);
await api("POST", `/agents/${reviewers.tests}/resume`);

// Narrow the security reviewer's brief. Delivered after its current tool call finishes.
await api("POST", `/agents/${reviewers.security}/steer`, {
  message:
    "Priority change from the lead: concentrate on what happens when `origin` is `true` or a function " +
    "and `credentials` is enabled. Drop unrelated findings.",
});

// ── 4. the editor waits for every reviewer, then merges ─────────────────────

const areaOf = Object.fromEntries(Object.entries(reviewers).map(([k, id]) => [id, k]));
const final = await api("POST", `/runs/${run.runId}/agents`, {
  parentAgentId: run.rootAgentId,
  spec: editor,
  waitFor: Object.values(reviewers),
  prompt:
    `Read /inputs.json and every file it lists; each is one reviewer's findings. ` +
    `The files map to areas as follows: ${JSON.stringify(areaOf)}. ` +
    `Write one review report in markdown: a title, then a section per area (Security, Correctness, Tests), ` +
    `with duplicate findings merged and the most severe first. If a reviewer's outcome is not "success", ` +
    `say that area was not reviewed. Output only the report.`,
});
labels.set(final.agentId, "editor");

const report = await waitResult(final.agentId);
stop.abort();
await watching;

// ── 5. results ──────────────────────────────────────────────────────────────

writeFileSync("review.md", report.result);
console.log(`\n${report.result}\n`);
console.log("Written to review.md\n");

const tree = await api("GET", `/runs/${run.runId}`);
for (const a of tree.agents) {
  console.log(`${"  ".repeat(a.depth)}${label(a.agentId).padEnd(22)} ${a.outcome ?? a.state}`);
}

await api("DELETE", `/runs/${run.runId}`);
