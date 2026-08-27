import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { readConfig } from "../config.js";
import type { CliCommand } from "./types.js";

export async function logs(name: string, opts: { json?: boolean } = {}): Promise<void> {
  if (!name) throw new Error("Usage: alineo logs <name> [--json]");

  const config = await readConfig();
  const adapter = new SQLiteAdapter(config.adapterPath);
  const client = new Sandbox({
    baseUrl: config.serverUrl,
    apiKey: config.apiKey,
    adapter,
    useServerProxy: config.useServerProxy,
  });

  // listByName() connects the adapter as a side effect, so the direct
  // adapter.readAll() call below is safe to make on the same instance.
  const sessions = await client.sandboxes.listByName(name);
  // TS's array indexing types this as SandboxDetails (not | undefined), but an empty
  // `sessions` array makes this genuinely undefined at runtime — this guard is real.
  const session = sessions[0] as (typeof sessions)[number] | undefined; // newest first
  if (!session) {
    throw new Error(`No session named '${name}' found in the ledger.`);
  }

  const entries = await adapter.readAll(name, session.sandboxId);

  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  console.log(`${entries.length} events for '${name}' (${session.sandboxId}):\n`);
  for (const entry of entries) {
    const ts = new Date(entry.ts).toISOString();
    const suffix = entry.error ? ` error=${entry.error}` : "";
    console.log(`${ts}  ${entry.event}${suffix}`);
    if (entry.payload !== undefined) {
      const payload = JSON.stringify(entry.payload);
      console.log(`  ${payload.length > 200 ? payload.slice(0, 200) + "..." : payload}`);
    }
  }
}

export const logsCommand: CliCommand = {
  name: "logs",
  group: "agent",
  variants: [
    { usage: "alineo logs <name> [--json]", summary: "Print ledger events for a session" },
  ],
  run: async (argv) => {
    await logs(argv[0] ?? "", { json: argv.includes("--json") });
  },
};
