import { getSessions, formatAge } from "../sessions-data.js";
import type { CliCommand } from "./types.js";

export async function agents(opts: { json?: boolean } = {}): Promise<void> {
  const { tracked, untracked } = await getSessions();

  if (opts.json) {
    console.log(JSON.stringify(tracked, null, 2));
    return;
  }

  const cols = [20, 38, 10, 10] as const;
  const header = ["NAME", "SANDBOX ID", "STARTED", "EXECS"];
  console.log(header.map((h, i) => h.padEnd(cols[i])).join("  "));
  console.log("-".repeat(80));

  for (const s of tracked) {
    console.log(
      [
        s.name.slice(0, cols[0] - 1).padEnd(cols[0]),
        s.sandboxId.padEnd(cols[1]),
        formatAge(s.startedAt).padEnd(cols[2]),
        String(s.execCount).padEnd(cols[3]),
      ].join("  "),
    );
  }
  if (tracked.length === 0) {
    console.log("(no running alineo-tracked sessions — run 'alineo spawn <spec>' to start one)");
  }

  if (untracked.length > 0) {
    console.log(`\nUntracked (not created by alineo, e.g. agent-spawned children):`);
    for (const id of untracked) console.log(`  ${id}`);
  }
}

export const agentsCommand: CliCommand = {
  name: "agents",
  group: "agent",
  variants: [{ usage: "alineo agents [--json]", summary: "List running agent sessions" }],
  run: async (argv) => {
    await agents({ json: argv.includes("--json") });
  },
};
