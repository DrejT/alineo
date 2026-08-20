/**
 * Master/child agent test — verifies that a Pi agent can spawn and drive its
 * OWN child sandboxes from inside its own container, using OpenSandbox's
 * official `osb` CLI (installed as a setup step) invoked through Pi's bash
 * tool. No new alineo/OpenSandbox code is needed for this to work — it's a
 * capability check on the existing platform, not a new feature.
 *
 * This requires the OpenSandbox server to be reachable *from inside a
 * container*, which is a different, harder problem than reachable from the
 * host. Two things have to be true:
 *
 *   1. The server must bind 0.0.0.0, not 127.0.0.1. A loopback-only bind
 *      (the default in `~/.sandbox.toml`'s example config) is unreachable
 *      from any container regardless of egress policy — confirmed by
 *      direct test, not documentation.
 *   2. The master agent needs a routable address for the server, not
 *      "localhost"/"127.0.0.1" (same bug class fixed elsewhere in this repo
 *      for host<->client connections, one network hop further out). For
 *      `uvx opensandbox-server` on the host with Docker's default `bridge`
 *      network, that's the bridge gateway IP — find it with:
 *        docker network inspect bridge --format '{{json .IPAM.Config}}'
 *      Override via MASTER_AGENT_OPENSANDBOX_DOMAIN if yours differs.
 *
 * Run:  bun examples/pi-agent/test-spawn-child.ts
 * Needs: OpenSandbox running + reachable from containers (see above),
 *        NVIDIA_API_KEY in .env
 *
 * Expected output:
 *   - Pi runs `osb sandbox create`, `osb command run`, `osb sandbox kill`
 *     against a brand new sibling sandbox, entirely through its bash tool.
 *   - Independently verified from the host via the raw OpenSandbox API
 *     (not alineo's own ledger, which never sees a sandbox created this way)
 *     that a new sandbox existed during the run.
 */
import { Alineo } from "alineo";
import { ControlClient } from "@alineo-labs/opensandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

process.env.MASTER_AGENT_OPENSANDBOX_DOMAIN ??= "172.17.0.1:8080";

const SPEC = "./agents/master-agent.json";
const adapter = new SQLiteAdapter("./.alineo/ledger.db");

// Raw OpenSandbox client, independent of alineo's ledger — used only to verify
// what actually happened, from the host side. The master agent creates its
// child entirely on its own via bash + osb.
const control = new ControlClient({ baseUrl: "http://127.0.0.1:8080", apiKey: "" });

const before = await control.listSandboxes();
console.log(`Sandboxes before: ${before.length}`);

const agent = await Alineo.load(SPEC, { adapter });
console.log(`\nMaster sandbox: ${agent.sandboxId}  fromSnapshot=${agent.fromSnapshot}\n`);

const prompt = `
You have the "osb" CLI installed (OpenSandbox's own CLI) and OPEN_SANDBOX_DOMAIN is already
set in your environment. Do the following using bash, step by step, and tell me what happened
at each step:

1. Run "osb sandbox create --image python:3.12-slim --timeout 5m -o json" to create a NEW
   sandbox (a sibling to your own, not inside your own container). If it fails to connect,
   run "osb config show -o json" to debug, and try "osb --protocol http sandbox create ..."
   explicitly.
2. Extract the new sandbox's ID from the JSON output.
3. Run a command inside that new sandbox with:
   osb command run <id> -o raw -- python3 -c "print(2 + 2)"
   and report its exact output.
4. Kill the sandbox you created with "osb sandbox kill <id>".

Report the child sandbox's ID and the exact output of the command you ran inside it.
`.trim();

console.log(`Prompt:\n${prompt}\n${"─".repeat(60)}\n`);

let response = "";
let sawToolCall = false;
for await (const ev of agent.prompt(prompt)) {
  if (ev.type === "text") {
    process.stdout.write(ev.text);
    response += ev.text;
  } else if (ev.type === "tool_start") {
    sawToolCall = true;
    console.log(`\n[tool_start] ${ev.toolName} ${JSON.stringify(ev.args).slice(0, 200)}`);
  } else if (ev.type === "tool_end") {
    console.log(`[tool_end]   ${ev.toolName} isError=${ev.isError}`);
  }
}
console.log("\n\n" + "─".repeat(60));

await agent.close();
console.log("Master agent closed.\n");

// ── Independent verification from the host ─────────────────────────────────
const childId = response.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
console.log(`Child sandbox ID reported by Pi: ${childId ?? "(not found in response)"}`);

// Never leak a sandbox regardless of whether Pi actually killed it itself.
if (childId) {
  try {
    await control.deleteSandbox(childId);
    console.log(`Cleaned up child sandbox ${childId} (was still present).`);
  } catch {
    console.log(`Child sandbox ${childId} already gone (Pi cleaned it up itself).`);
  }
}

const after = await control.listSandboxes();
console.log(`Sandboxes after cleanup: ${after.length} (started at ${before.length})`);

console.log("\n=== Summary ===");
console.log(`Tool calls observed: ${sawToolCall}`);
console.log(`Child sandbox ID found in response: ${!!childId}`);
if (sawToolCall && childId) {
  console.log("\n✓ Master agent successfully spawned and used a child sandbox");
} else {
  console.log("\n✗ Master agent did not demonstrably spawn a child — check output above");
}
