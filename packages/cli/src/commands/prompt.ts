import { Agent } from "@alineo-labs/agent";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { readConfig } from "../config.js";
import { collectReply } from "../agent-prompt.js";
import { flag } from "./args.js";
import type { CliCommand } from "./types.js";

/**
 * Addressed by sandbox ID, not session name — names aren't unique (re-running
 * `alineo spawn` on the same spec produces two sandboxes with the same name)
 * and a name-based ledger lookup can hand back a sandbox that died ungracefully
 * (crashed before its `close()` ran, expired via OpenSandbox's own TTL) since
 * nothing ever told the ledger it stopped. `Agent.resume()`'s own `connect()`
 * call is the actual authoritative liveness check — addressing by ID means
 * that's the ONLY check, not a second opinion after an already-stale one.
 *
 * `opts.specPath` lets a caller skip `Agent.resume()`'s own ledger lookup for
 * the spec file entirely — necessary when prompting a sandbox whose
 * `sandbox_created` event lives in a different ledger than this CLI
 * invocation's own (e.g. a child spawned via `alineo fork` from inside
 * another sandbox).
 */
export async function prompt(
  sandboxId: string,
  message: string,
  opts: { json?: boolean; specPath?: string; timeoutSeconds?: number } = {},
): Promise<void> {
  if (!sandboxId || !message)
    throw new Error(
      "Usage: alineo prompt <sandbox-id> <message> [--spec <path>] [--timeout SECONDS] [--json]",
    );

  const config = await readConfig();
  const adapter = new SQLiteAdapter(config.adapterPath);
  const agent = await Agent.resume(sandboxId, { adapter, specPath: opts.specPath });

  const collected = await collectReply(agent, message, {
    inactivityTimeoutMs: opts.timeoutSeconds !== undefined ? opts.timeoutSeconds * 1000 : undefined,
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          name: agent.name,
          sandboxId: agent.sandboxId,
          reply: collected.text,
          toolCalls: collected.toolCalls,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (collected.text) {
    console.log(collected.text);
  } else if (collected.toolCalls.length > 0) {
    const names = collected.toolCalls.map((t) => t.name).join(", ");
    console.log(`[alineo] (no final text — ${collected.toolCalls.length} tool call(s): ${names})`);
  }
}

export const promptCommand: CliCommand = {
  name: "prompt",
  group: "agent",
  variants: [
    {
      usage: "alineo prompt <sandbox-id> <msg>",
      summary: "Send one prompt to a running sandbox, print the reply",
    },
  ],
  run: async (argv) => {
    const sandboxId = argv[0] ?? "";
    const message = argv.slice(1).find((a) => !a.startsWith("--")) ?? "";
    const timeoutFlag = flag(argv, "--timeout");
    await prompt(sandboxId, message, {
      json: argv.includes("--json"),
      specPath: flag(argv, "--spec"),
      timeoutSeconds: timeoutFlag !== undefined ? Number(timeoutFlag) : undefined,
    });
  },
};
