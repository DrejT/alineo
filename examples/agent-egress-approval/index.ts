/**
 * Approve-on-egress hold — a Pi agent whose reach to `api.github.com` is gated behind an
 * operator decision.
 *
 * The `GITHUB_TOKEN` binding in `agents/egress-agent.json` has `approval: "hold"`, so:
 *   - the agent's sandbox starts with `api.github.com` denied at the egress sidecar (every
 *     other host — including the model API — still works);
 *   - the first time the agent tries to reach it, the request pauses and `onEgressRequest`
 *     is called on the host;
 *   - only on `"allow-once"` / `"allow-always"` does the sidecar's rule flip to allow, and
 *     the (also transparently injected) `GITHUB_TOKEN` credential goes out with the request.
 *
 * Enforcement is entirely out-of-process at the sidecar — a compromised in-sandbox agent
 * cannot skip it.
 *
 * Run: `cd examples/agent-egress-approval && bun install && bun start`
 * Needs: OpenSandbox running (`bunx alineo-cli init`, with `egress.mode = "dns+nft"`), a
 * `NVIDIA_API_KEY`, and optionally a real `GITHUB_TOKEN` (the demo works without one — the
 * request just comes back 401).
 */
import { Alineo, type EgressRequest, type EgressDecision } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const adapter = new SQLiteAdapter("./.alineo/ledger.db");
const rule = (s: string) => console.log(`\n${"─".repeat(72)}\n${s}\n${"─".repeat(72)}`);

/** The operator: allow GitHub once, refuse everything else. */
async function onEgressRequest(req: EgressRequest): Promise<EgressDecision> {
  const decision: EgressDecision = req.host === "api.github.com" ? "allow-once" : "deny";
  console.log(`\n  ⏸  egress approval needed — ${req.host}  →  ${decision}`);
  return decision;
}

rule('1 · load the agent — api.github.com starts denied (approval: "hold")');
const agent = await Alineo.load(await Bun.file("./agents/egress-agent.json").json(), {
  adapter,
  onEgressRequest,
});

try {
  rule("2 · ask it to call the GitHub API — the request pauses for approval, then succeeds");
  console.log('prompt: "curl -s -o /dev/null -w \'%{http_code}\' https://api.github.com/user"\n');
  process.stdout.write("> ");
  for await (const ev of agent.prompt(
    "Run exactly this shell command and report only its output: " +
      "curl -s -o /dev/null -w '%{http_code}' https://api.github.com/user",
  )) {
    if (ev.type === "text") process.stdout.write(ev.text);
    else if (ev.type === "tool_start") process.stdout.write(`\n[tool: ${ev.toolName}]\n`);
  }

  rule("3 · the ledger audit trail — every egress request + resolution");
  const entries = await adapter.readAll(agent.name, agent.sandboxId);
  for (const e of entries) {
    if (e.event === "permission_requested" || e.event === "permission_resolved") {
      console.log(`  ${e.event.padEnd(22)} ${JSON.stringify(e.payload)}`);
    }
  }
} finally {
  await agent.close(); // also stops the egress-approval listener
}
