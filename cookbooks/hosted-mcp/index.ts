/**
 * Recipe: two people use one hosted alineo MCP, and neither can see the other's work.
 *
 *   alice ─┐                                       ┌─ tenant "alice": her runs, agents, memory
 *          ├─ alineo-mcp over HTTP ─ alineod ──────┤
 *   bob ───┘   (forwards each caller's key)        └─ tenant "bob": his
 *
 *   1. no key                          the MCP endpoint answers 401
 *   2. alice: spec_add                 validates an inline spec (this server stores none)
 *   3. alice: run_start                starts a run with a first prompt
 *   4. bob:   run_list, run_get        sees none of alice's runs; her run id is a 404 to him
 *   5. alice: result_get               reads her agent's answer
 *   6. alice: run_list, run_stop       sees her run, then closes it
 *
 * Run serve.ts first, in its own terminal (see README). Each MCP call here is the same one a chat
 * client (Claude Code, Cursor, ...) makes when its `mcpServers` entry points at the URL with a key.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:4700/mcp";
const ALICE_KEY = process.env.ALICE_KEY ?? "alice-demo-key";
const BOB_KEY = process.env.BOB_KEY ?? "bob-demo-key";
const helper = await Bun.file(new URL("./agents/helper.json", import.meta.url)).json();

interface McpUser {
  // oxlint-disable-next-line typescript/no-explicit-any -- recipe-local, untyped like mcp-agent-swarm's call()
  call(tool: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

/** Connect as one user. The key rides on every request as `Authorization: Bearer <key>`. */
async function connectAs(name: string, key: string): Promise<McpUser> {
  const client = new Client({ name: `hosted-mcp-${name}`, version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return {
    async call(tool, args = {}) {
      // result_get long-polls for up to 240 s on the server, so allow more than that here.
      const result = await client.callTool({ name: tool, arguments: args }, { timeout: 300_000 });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      if (result.isError) throw new Error(`${tool} → ${text}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    close: () => client.close(),
  };
}

/** The error message of a call that should fail, or a thrown error when it succeeds. */
async function refused(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected this call to be refused, and it was not");
}

console.log("1. No key, no MCP");
const anonymous = await fetch(MCP_URL, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
console.log(`   POST /mcp with no Authorization header → ${anonymous.status}`);
if (anonymous.status !== 401) throw new Error("the MCP answered a caller with no key");

const alice = await connectAs("alice", ALICE_KEY);
const bob = await connectAs("bob", BOB_KEY);
let runId: string | undefined;

try {
  console.log("\n2. alice validates her spec");
  const added = await alice.call("spec_add", { spec: helper });
  console.log(`   spec_add → '${added.name}' is valid`);

  console.log("\n3. alice starts a run");
  const run = await alice.call("run_start", {
    spec: added.spec,
    prompt: "In one sentence: what does a sandbox give an AI coding agent?",
  });
  runId = run.runId as string;
  console.log(`   run_start → run ${run.runId}, root agent ${run.rootAgentId}`);

  console.log("\n4. bob cannot see it");
  const bobsRuns = (await bob.call("run_list", {})).runs as Array<{ runId: string }>;
  console.log(`   bob run_list → ${bobsRuns.length} run(s)`);
  if (bobsRuns.some((r) => r.runId === runId)) throw new Error("bob can list alice's run");
  console.log(`   bob run_get ${runId} → ${await refused(bob.call("run_get", { runId }))}`);
  console.log(
    `   bob agent_get ${run.rootAgentId} → ${await refused(bob.call("agent_get", { agentId: run.rootAgentId }))}`,
  );

  console.log("\n5. alice reads her answer (the sandbox and the first turn take a minute or two)");
  for (;;) {
    const res = await alice.call("result_get", { agentId: run.rootAgentId, waitSeconds: 120 });
    if (res.state === "settled") {
      console.log(`   result_get → ${res.outcome}: ${res.result || "(no text)"}`);
      if (res.outcome !== "success") {
        throw new Error(
          "the agent's turn did not succeed. Is NVIDIA_API_KEY set in serve.ts's environment? serve.ts's log says why.",
        );
      }
      break;
    }
    console.log(`   result_get → ${res.state}, still waiting`);
  }

  console.log("\n6. alice sees her run, then closes it");
  const alicesRuns = (await alice.call("run_list", { state: "open" })).runs as Array<{
    runId: string;
  }>;
  console.log(`   alice run_list → ${alicesRuns.map((r) => r.runId).join(", ")}`);
  await alice.call("run_stop", { runId });
  runId = undefined;
  console.log("   run_stop → closed");
} finally {
  if (runId) await alice.call("run_stop", { runId }).catch(() => {});
  await alice.close();
  await bob.close();
}
