import {
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  type CliRenderer,
} from "@opentui/core";
import { Alineo } from "alineo";
import type { SandboxDetails } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { readConfig } from "../config.js";

export interface LogsView {
  box: BoxRenderable;
  dispose(): void;
}

export function createLogsView(
  renderer: CliRenderer,
  session: SandboxDetails,
  onBack: () => void,
): LogsView {
  const box = new BoxRenderable(renderer, {
    id: "logs",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
  });

  box.add(
    new TextRenderable(renderer, {
      id: "logs-title",
      content: `alineo — logs: ${session.name} (${session.sandboxId.slice(0, 8)})   (↑/↓ scroll · esc back)`,
    }),
  );

  const scroll = new ScrollBoxRenderable(renderer, {
    id: "logs-scroll",
    width: "100%",
    height: "100%",
    stickyScroll: true,
    stickyStart: "top",
  });
  box.add(scroll);
  scroll.focus();

  scroll.add(new TextRenderable(renderer, { id: "logs-loading", content: "loading..." }));

  async function load(): Promise<void> {
    const config = await readConfig();
    const adapter = new SQLiteAdapter(config.adapterPath);
    const client = new Alineo({
      baseUrl: config.serverUrl,
      apiKey: config.apiKey,
      adapter,
      useServerProxy: config.useServerProxy,
    });
    // Ensures the adapter is connected before the direct readAll() call below.
    await client.sandboxes.list();

    for (const child of scroll.getChildren()) scroll.remove(child);

    const entries = await adapter.readAll(session.name, session.sandboxId);
    if (entries.length === 0) {
      scroll.add(new TextRenderable(renderer, { id: "logs-empty", content: "(no events)" }));
      return;
    }
    entries.forEach((entry, i) => {
      const ts = new Date(entry.ts).toISOString();
      const suffix = entry.error ? ` error=${entry.error}` : "";
      scroll.add(
        new TextRenderable(renderer, {
          id: `logs-line-${i}`,
          content: `${ts}  ${entry.event}${suffix}`,
        }),
      );
    });
  }

  const onKeypress = (event: { name: string }) => {
    if (event.name === "escape") onBack();
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
