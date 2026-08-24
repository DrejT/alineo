import { existsSync } from "fs";
import { unlink } from "fs/promises";
import { join } from "path";
import { readConfig } from "../config.js";
import type { CliCommand } from "./types.js";

export async function remove(name: string): Promise<void> {
  if (!name) throw new Error("Usage: alineo remove <name>");

  const config = await readConfig();
  const dest = join(config.agentsDir, `${name}.json`);

  if (!existsSync(dest)) {
    throw new Error(
      `No agent spec named '${name}' in '${config.agentsDir}'. Run 'alineo list' to see available specs.`,
    );
  }

  await unlink(dest);
  console.log(`Removed agent spec '${name}'`);
}

export const removeCommand: CliCommand = {
  name: "remove",
  group: "sdk",
  variants: [{ usage: "alineo remove <name>", summary: "Remove a saved agent spec" }],
  run: async (argv) => {
    await remove(argv[0] ?? "");
  },
};
