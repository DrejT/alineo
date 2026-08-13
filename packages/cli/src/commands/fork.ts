import { Alineo, SandboxStatus } from "alineo";
import { Agent } from "@alineo-labs/agent";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { readConfig } from "../config.js";
import { collectReply } from "../agent-prompt.js";
import { flag } from "./args.js";
import type { CliCommand } from "./types.js";

/**
 * Fork a running session's own sandbox into a brand-new independent child, per
 * `Agent.spawn()`. Meant to be run BY that session's own Pi bash tool — `name` is
 * the caller's own running session, not the child's. Uses `Agent.attach()`, not
 * `Agent.resume()`, to avoid killing the very bridge process making this call.
 *
 * Resolves the caller's own sandbox ID from `ALINEO_SANDBOX_ID` when present
 * (written to `/etc/alineo-env` by every agent-creation path, so it's already
 * in this process's env since it's a descendant of Pi's own bridge process) —
 * preferred over a ledger lookup when available, since the calling agent may
 * have been created via an `IStorageAdapter` this CLI invocation has no
 * access to (e.g. a host-side ledger for an `Agent.load()` call this
 * sandbox's own `alineo.config.json` knows nothing about). Falls back to
 * looking `name` up in the ledger of currently-running sessions when
 * `ALINEO_SANDBOX_ID` isn't set (e.g. invoked outside a sandbox). `name` also
 * always labels the resulting `Agent` object.
 */
export async function fork(
  name: string,
  childSpecPath: string,
  opts: {
    prompt?: string;
    depth?: number;
    max?: number;
    json?: boolean;
    timeoutSeconds?: number;
  } = {},
): Promise<void> {
  if (!name || !childSpecPath)
    throw new Error(
      "Usage: alineo fork <name> <child-spec> [--prompt <msg>] [--depth N] [--max N] " +
        "[--timeout SECONDS] [--json]",
    );

  const config = await readConfig();
  const adapter = new SQLiteAdapter(config.adapterPath);

  let selfSandboxId = process.env.ALINEO_SANDBOX_ID;
  if (!selfSandboxId) {
    const client = new Alineo({
      baseUrl: config.serverUrl,
      apiKey: config.apiKey,
      adapter,
      useServerProxy: config.useServerProxy,
    });
    const sessions = await client.sandboxes.list({ status: SandboxStatus.Running });
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      throw new Error(
        `No running session named '${name}'. Run 'alineo agents' to see running sessions.`,
      );
    }
    selfSandboxId = session.sandboxId;
  }

  const self = await Agent.attach(selfSandboxId, { adapter, name });
  const child = await self.spawn(childSpecPath, { spawnDepth: opts.depth, maxAgents: opts.max });

  const collected = opts.prompt
    ? await collectReply(child, opts.prompt, {
        inactivityTimeoutMs:
          opts.timeoutSeconds !== undefined ? opts.timeoutSeconds * 1000 : undefined,
      })
    : undefined;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          name: child.name,
          sandboxId: child.sandboxId,
          reply: collected?.text,
          toolCalls: collected?.toolCalls,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\n[alineo] forked: ${child.name}  sandbox: ${child.sandboxId}`);
  if (collected) {
    if (collected.text) {
      console.log(`\n${collected.text}`);
    } else if (collected.toolCalls.length > 0) {
      const names = collected.toolCalls.map((t) => t.name).join(", ");
      console.log(
        `\n[alineo] (no final text — ${collected.toolCalls.length} tool call(s): ${names})`,
      );
    }
  }
}

export const forkCommand: CliCommand = {
  name: "fork",
  group: "agent",
  variants: [
    {
      usage: "alineo fork <name> <child-spec>",
      summary: "Fork a running session's own live sandbox into a new child",
    },
  ],
  run: async (argv) => {
    const name = argv[0] ?? "";
    const childSpec = argv.slice(1).find((a) => !a.startsWith("--")) ?? "";
    const depthFlag = flag(argv, "--depth");
    const maxFlag = flag(argv, "--max");
    const timeoutFlag = flag(argv, "--timeout");
    await fork(name, childSpec, {
      prompt: flag(argv, "--prompt"),
      depth: depthFlag !== undefined ? Number(depthFlag) : undefined,
      max: maxFlag !== undefined ? Number(maxFlag) : undefined,
      timeoutSeconds: timeoutFlag !== undefined ? Number(timeoutFlag) : undefined,
      json: argv.includes("--json"),
    });
  },
};
