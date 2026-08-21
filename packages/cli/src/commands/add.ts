import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { readConfig } from "../config.js";
import { validateAgentSpec, type AgentSpec } from "../schema.js";
import { flag } from "./args.js";
import type { CliCommand } from "./types.js";

export async function add(
  url: string,
  opts: { name?: string; log?: (message: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? console.log;
  if (!url) throw new Error("Usage: alineo add <url>");

  const config = await readConfig();
  const spec = await fetchSpec(url);

  for (const depUrl of spec.registryDependencies ?? []) {
    log(`Resolving dependency: ${depUrl}`);
    await add(depUrl, { log });
  }

  const name = opts.name ?? spec.name;
  const agentsDir = config.agentsDir;

  if (!existsSync(agentsDir)) await mkdir(agentsDir, { recursive: true });

  const dest = join(agentsDir, `${name}.json`);
  await Bun.write(dest, JSON.stringify(spec, null, 2) + "\n");

  log(`Agent spec saved: ${dest}`);
  log(`Load it with: Alineo.load(await Bun.file("${dest}").json(), { adapter }) from alineo`);
}

async function fetchSpec(url: string): Promise<AgentSpec> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch spec: ${res.status} ${res.statusText}`);
    return validateAgentSpec(await res.json());
  }
  const file = Bun.file(url);
  if (!(await file.exists())) throw new Error(`File not found: ${url}`);
  return validateAgentSpec(await file.json());
}

export const addCommand: CliCommand = {
  name: "add",
  group: "sdk",
  variants: [
    { usage: "alineo add <url> [--name <n>]", summary: "Fetch and save an agent spec locally" },
  ],
  run: async (argv) => {
    const url = argv.find((a) => !a.startsWith("--")) ?? "";
    await add(url, { name: flag(argv, "--name") });
  },
};
