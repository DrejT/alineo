import { Sandbox } from "@alineo-labs/sandbox";
import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { readConfig } from "../config.js";
import { flag } from "./args.js";
import type { CliCommand } from "./types.js";

/**
 * Redirect a running session without restarting it — the agent-facing counterpart to
 * alineod's `POST /agents/:id/steer` (research/swarm-control.md §8), for a session steering
 * a sandbox it doesn't itself own the control plane for (a parent redirecting a child it
 * forked, most commonly).
 *
 * Uses `Alineo.reattach()`, not `Alineo.resume()` — the whole point of steering a child is
 * usually that it's mid-turn; `resume()` would kill its bridge and abort whatever it's doing,
 * exactly what you're trying to avoid. `reattach()` rebinds to the bridge already running
 * there with zero side effects, then a plain ack-only RPC call delivers the message.
 *
 * Addressed by sandbox ID only, same reasoning as `prompt.ts`: names aren't unique and a
 * name-based lookup can hand back a session that died ungracefully. `alineo fork ... --json`
 * already reports back the child's `sandboxId` — that's what a parent passes here.
 *
 * No spec is required — the sandbox's own ledger entry gives us its real name for a readable
 * log line; a bare `{ name, cli: "pi" }` stub is otherwise enough for `reattach()` (env/budget
 * resolution only matters for a fresh bridge start, which this never does). Pass `--spec
 * <path>` only if the child's real spec happens to be on hand locally.
 *
 * Timing: `steer` is delivered after the target's CURRENT turn finishes its tool calls, but
 * before its next LLM call — it does not interrupt a tool call already running (Pi's own RPC
 * semantics, not alineo's). If you need to cut off a child immediately regardless of what
 * it's doing, use `alineo kill <sandbox-id>` instead; steer is for redirecting cleanly, not
 * stopping urgently.
 */
export async function steer(
  sandboxId: string,
  message: string,
  opts: { specPath?: string } = {},
): Promise<void> {
  if (!sandboxId || !message) {
    throw new Error("Usage: alineo steer <sandbox-id> <message> [--spec <path>]");
  }

  const config = await readConfig();
  const adapter = new SQLiteAdapter(config.adapterPath);

  const client = new Sandbox({
    baseUrl: config.serverUrl,
    apiKey: config.apiKey,
    adapter,
    useServerProxy: config.useServerProxy,
  });
  const sessions = await client.sandboxes.list();
  const displayName = sessions.find((s) => s.sandboxId === sandboxId)?.name ?? sandboxId;

  const agent = await Alineo.reattach(sandboxId, {
    adapter,
    ...(opts.specPath ? { specPath: opts.specPath } : { spec: { name: displayName, cli: "pi" } }),
  });

  await agent.steer(message);
  console.log(`[alineo] steered ${agent.name} (${agent.sandboxId})`);
}

export const steerCommand: CliCommand = {
  name: "steer",
  group: "agent",
  variants: [
    {
      usage: "alineo steer <sandbox-id> <message>",
      summary: "Redirect a running session — lands at its next turn boundary, not instantly",
    },
  ],
  run: async (argv) => {
    const sandboxId = argv[0] ?? "";
    const message = argv.slice(1).find((a) => !a.startsWith("--")) ?? "";
    await steer(sandboxId, message, { specPath: flag(argv, "--spec") });
  },
};
