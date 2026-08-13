import { existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type CliRenderer,
  type SelectOption,
} from "@opentui/core";
import type { AgentSpec } from "@alineo-labs/agent";
import { readConfig, type AlineoConfig } from "../config.js";

const REGISTRY_INDEX_URL = "https://registry.alineo.dev/agents/index.json";

interface RegistryItem {
  name: string;
  title: string;
  description: string;
  categories: string[];
  url: string;
}

interface LaunchOption {
  name: string;
  description: string;
  origin: "local" | "registry";
  /** Set for local specs — already on disk. */
  specPath?: string;
  /** Set for registry specs — needs fetching via `add()` before it can be loaded. */
  registryUrl?: string;
}

export interface NewSessionView {
  box: BoxRenderable;
  dispose(): void;
}

async function fetchRegistryItems(): Promise<RegistryItem[]> {
  const res = await fetch(REGISTRY_INDEX_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`registry returned ${res.status}`);
  return (await res.json()) as RegistryItem[];
}

async function listLocalSpecs(
  config: AlineoConfig,
): Promise<{ name: string; specPath: string; title: string; description: string }[]> {
  if (!existsSync(config.agentsDir)) return [];
  const out: { name: string; specPath: string; title: string; description: string }[] = [];
  for (const f of readdirSync(config.agentsDir).filter((f) => f.endsWith(".json"))) {
    try {
      const specPath = join(config.agentsDir, f);
      const spec = (await Bun.file(specPath).json()) as Partial<AgentSpec>;
      const name = spec.name ?? f.replace(/\.json$/, "");
      out.push({ name, specPath, title: spec.title ?? name, description: spec.description ?? "" });
    } catch {
      // skip unreadable specs — same tolerance as `alineo list`
    }
  }
  return out;
}

/**
 * Combines locally-`add`ed specs with the registry.alineo.dev catalog into one
 * pick list. Selecting a registry entry fetches + saves it (via the same
 * `add()` command `alineo add` uses) before launching, so it becomes a local
 * spec from then on.
 */
export function createNewSessionView(
  renderer: CliRenderer,
  onLaunch: (specPath: string) => void,
  onCancel: () => void,
): NewSessionView {
  const box = new BoxRenderable(renderer, {
    id: "new-session",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
  });

  box.add(
    new TextRenderable(renderer, {
      id: "new-session-title",
      content: "alineo — start an agent   (↑/↓ move · enter run · esc cancel)",
    }),
  );

  const select = new SelectRenderable(renderer, {
    id: "new-session-select",
    width: "100%",
    height: "100%",
    options: [{ name: "loading...", description: "", value: null }],
  });
  box.add(select);
  select.focus();

  const status = new TextRenderable(renderer, { id: "new-session-status", content: "" });
  box.add(status);

  async function load(): Promise<void> {
    const config = await readConfig();
    const local = await listLocalSpecs(config);
    const localNames = new Set(local.map((l) => l.name));

    const options: LaunchOption[] = local.map((l) => ({
      name: l.name,
      description: l.description,
      origin: "local",
      specPath: l.specPath,
    }));

    try {
      const registryItems = await fetchRegistryItems();
      for (const item of registryItems) {
        if (localNames.has(item.name)) continue; // already added locally
        options.push({
          name: item.name,
          description: item.description,
          origin: "registry",
          registryUrl: item.url,
        });
      }
    } catch (err) {
      status.content = `registry unreachable (${err instanceof Error ? err.message : String(err)}) — showing local specs only`;
    }

    select.options =
      options.length > 0
        ? options.map((o) => ({
            name: `${o.name}  (${o.origin})`,
            description: o.description,
            value: o,
          }))
        : [
            {
              name: "(no specs found)",
              description: "add one at registry.alineo.dev, or 'alineo add <url>'",
              value: null,
            },
          ];
  }

  async function launch(entry: LaunchOption): Promise<void> {
    status.content = `starting ${entry.name}...`;
    try {
      let specPath = entry.specPath;
      if (!specPath && entry.registryUrl) {
        const { add } = await import("../commands/add.js");
        await add(entry.registryUrl, { log: (msg) => (status.content = msg) });
        const config = await readConfig();
        specPath = join(config.agentsDir, `${entry.name}.json`);
      }
      if (!specPath) throw new Error("no spec path resolved");
      onLaunch(specPath);
    } catch (err) {
      status.content = `failed to start '${entry.name}': ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  select.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
    const entry = option.value as LaunchOption | null;
    if (entry) void launch(entry);
  });

  const onKeypress = (event: { name: string }) => {
    if (event.name === "escape") onCancel();
  };
  renderer.keyInput.on("keypress", onKeypress);

  void load();

  return {
    box,
    dispose() {
      renderer.keyInput.off("keypress", onKeypress);
    },
  };
}
