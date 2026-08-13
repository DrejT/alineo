import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { readConfig } from "../config.js";
import type { AgentSpec } from "../schema.js";
import type { CliCommand } from "./types.js";

export async function list(): Promise<void> {
  const config = await readConfig();
  const dir = config.agentsDir;

  if (!existsSync(dir)) {
    console.log(`No agents dir found at '${dir}'. Run 'alineo add <url>' to add an agent spec.`);
    return;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

  if (files.length === 0) {
    console.log("No agent specs found. Run 'alineo add <url>' to add one.");
    return;
  }

  const cols = [20, 8, 0] as const;
  const header = ["NAME", "CLI", "DESCRIPTION"];
  console.log(header.map((h, i) => (cols[i] ? h.padEnd(cols[i]) : h)).join("  "));
  console.log("-".repeat(60));

  for (const file of files) {
    try {
      const spec = (await Bun.file(join(dir, file)).json()) as Partial<AgentSpec>;
      const name = (spec.name ?? file.replace(/\.json$/, "")).slice(0, 19);
      const cli = (spec.cli ?? "?").slice(0, 7);
      const desc = spec.description ?? spec.title ?? "";
      console.log([name.padEnd(cols[0]), cli.padEnd(cols[1]), desc].join("  "));
    } catch {
      console.log(`${file.replace(/\.json$/, "").padEnd(cols[0])}  (unreadable)`);
    }
  }
}

export const listCommand: CliCommand = {
  name: "list",
  group: "sdk",
  variants: [{ usage: "alineo list", summary: "List saved agent specs" }],
  run: async () => {
    await list();
  },
};
