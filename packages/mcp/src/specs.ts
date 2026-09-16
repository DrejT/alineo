/**
 * Local agent-spec cache — mirrors `alineo add` / `list` / `remove`
 * (`packages/cli/src/commands/{add,list,remove}.ts`), returning structured results instead of
 * writing to stdout.
 */
import { existsSync, readdirSync } from "fs";
import { mkdir, unlink } from "fs/promises";
import { join } from "path";
import { validateAgentSpec, type AgentSpec } from "alineo";
import { readConfig } from "./config.js";

export interface AddSpecResult {
  name: string;
  path: string;
  resolvedDependencies: string[];
}

export async function addSpec(url: string, name?: string): Promise<AddSpecResult> {
  if (!url) throw new Error("A spec URL or local file path is required.");

  const config = await readConfig();
  const spec = await fetchSpec(url);

  const resolvedDependencies: string[] = [];
  for (const depUrl of spec.registryDependencies ?? []) {
    await addSpec(depUrl);
    resolvedDependencies.push(depUrl);
  }

  const specName = name ?? spec.name;
  const agentsDir = config.agentsDir;
  if (!existsSync(agentsDir)) await mkdir(agentsDir, { recursive: true });

  const dest = join(agentsDir, `${specName}.json`);
  await Bun.write(dest, JSON.stringify(spec, null, 2) + "\n");

  return { name: specName, path: dest, resolvedDependencies };
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

export interface SpecSummary {
  name: string;
  cli: string;
  description: string;
}

export async function listSpecs(): Promise<SpecSummary[]> {
  const config = await readConfig();
  const dir = config.agentsDir;
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const specs: SpecSummary[] = [];
  for (const file of files) {
    try {
      const spec = (await Bun.file(join(dir, file)).json()) as Partial<AgentSpec>;
      specs.push({
        name: spec.name ?? file.replace(/\.json$/, ""),
        cli: spec.cli ?? "?",
        description: spec.description ?? spec.title ?? "",
      });
    } catch {
      specs.push({ name: file.replace(/\.json$/, ""), cli: "?", description: "(unreadable)" });
    }
  }
  return specs;
}

export async function removeSpec(name: string): Promise<void> {
  if (!name) throw new Error("A spec name is required.");

  const config = await readConfig();
  const dest = join(config.agentsDir, `${name}.json`);
  if (!existsSync(dest)) {
    throw new Error(`No agent spec named '${name}' in '${config.agentsDir}'.`);
  }
  await unlink(dest);
}
