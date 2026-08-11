import { Agent } from "@drej/agent";
import { SQLiteAdapter } from "@drej/sqlite";
import { readConfig } from "../config.js";
import { collectReply } from "../agent-prompt.js";
import { flag } from "./args.js";
import type { CliCommand } from "./types.js";

/**
 * Start a brand-new, independent agent sandbox from a spec's own snapshot —
 * unlike `drejx fork`, which forks a running session's *live* sandbox state
 * instead. This is the entry point for a fresh session (e.g. a host-level Pi
 * session starting the master of an RLM run); `fork` is what a running
 * session uses to fan out its own live state into children.
 */
export async function spawn(
  specPath: string,
  opts: {
    prompt?: string;
    rebuild?: boolean;
    json?: boolean;
    depth?: number;
    max?: number;
    timeoutSeconds?: number;
    runId?: string;
  } = {},
): Promise<void> {
  if (!specPath)
    throw new Error(
      "Usage: drejx spawn <spec> [--prompt <msg>] [--rebuild] [--depth N] [--max N] " +
        "[--timeout SECONDS] [--run-id ID] [--json]",
    );

  const config = await readConfig();
  const adapter = new SQLiteAdapter(config.adapterPath);
  const agent = await Agent.load(specPath, {
    adapter,
    rebuild: opts.rebuild,
    spawnDepth: opts.depth,
    maxAgents: opts.max,
    runId: opts.runId,
  });

  const collected = opts.prompt
    ? await collectReply(agent, opts.prompt, {
        inactivityTimeoutMs:
          opts.timeoutSeconds !== undefined ? opts.timeoutSeconds * 1000 : undefined,
      })
    : undefined;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          name: agent.name,
          sandboxId: agent.sandboxId,
          reply: collected?.text,
          toolCalls: collected?.toolCalls,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\n[drejx] session: ${agent.name}  sandbox: ${agent.sandboxId}`);
  if (collected) {
    if (collected.text) {
      console.log(`\n${collected.text}`);
    } else if (collected.toolCalls.length > 0) {
      const names = collected.toolCalls.map((t) => t.name).join(", ");
      console.log(
        `\n[drejx] (no final text — ${collected.toolCalls.length} tool call(s): ${names})`,
      );
    }
  }
}

export const spawnCommand: CliCommand = {
  name: "spawn",
  group: "agent",
  variants: [
    { usage: "drejx spawn <spec>", summary: "Start a fresh agent sandbox, print its name, exit" },
    {
      usage: "drejx spawn <spec> --prompt <msg>",
      summary: "Start it, send one prompt, print the reply, exit",
    },
  ],
  run: async (argv) => {
    const specPath = argv.find((a) => !a.startsWith("--")) ?? "";
    const depthFlag = flag(argv, "--depth");
    const maxFlag = flag(argv, "--max");
    const timeoutFlag = flag(argv, "--timeout");
    await spawn(specPath, {
      prompt: flag(argv, "--prompt"),
      rebuild: argv.includes("--rebuild"),
      json: argv.includes("--json"),
      depth: depthFlag !== undefined ? Number(depthFlag) : undefined,
      max: maxFlag !== undefined ? Number(maxFlag) : undefined,
      timeoutSeconds: timeoutFlag !== undefined ? Number(timeoutFlag) : undefined,
      runId: flag(argv, "--run-id"),
    });
  },
};
