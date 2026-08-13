import {
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type CliRenderer,
  type SelectOption,
} from "@opentui/core";
import { Alineo } from "alineo";
import type { SandboxDetails } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { readConfig } from "../config.js";
import { getSessions, formatAge } from "../sessions-data.js";

export interface DashboardView {
  box: BoxRenderable;
  setStatus(message: string): void;
  dispose(): void;
}

export function createDashboardView(
  renderer: CliRenderer,
  onOpen: (session: SandboxDetails) => void,
  onQuit: () => void,
  onNew: () => void,
  onLogs: (session: SandboxDetails) => void,
): DashboardView {
  const box = new BoxRenderable(renderer, {
    id: "dashboard",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
  });

  box.add(
    new TextRenderable(renderer, {
      id: "dashboard-title",
      content:
        "alineo — sessions   (↑/↓ move · enter chat · n new · l logs · k kill · r refresh · q quit)",
    }),
  );

  const select = new SelectRenderable(renderer, {
    id: "dashboard-select",
    width: "100%",
    height: "100%",
    options: [],
  });
  box.add(select);
  select.focus();

  const status = new TextRenderable(renderer, { id: "dashboard-status", content: "loading..." });
  box.add(status);

  async function refresh(): Promise<void> {
    status.content = "refreshing...";
    const { tracked, untracked } = await getSessions();

    const options: SelectOption[] = tracked.map((s) => ({
      name: `${s.name}  ${s.sandboxId.slice(0, 8)}`,
      description: `${formatAge(s.startedAt)} · ${s.execCount} execs`,
      value: s,
    }));
    select.options =
      options.length > 0
        ? options
        : [
            {
              name: "(no running sessions)",
              description: "press 'n' to start one",
              value: null,
            },
          ];

    status.content =
      untracked.length > 0
        ? `${tracked.length} tracked · ${untracked.length} untracked (agent-spawned) sandboxes running`
        : `${tracked.length} tracked session(s) running`;
  }

  async function killSelected(): Promise<void> {
    const session = select.getSelectedOption()?.value as SandboxDetails | null;
    if (!session) return;
    status.content = `killing ${session.name}...`;
    try {
      const config = await readConfig();
      const client = new Alineo({
        baseUrl: config.serverUrl,
        apiKey: config.apiKey,
        adapter: new SQLiteAdapter(config.adapterPath),
        useServerProxy: config.useServerProxy,
      });
      const sb = await client.connect(session.sandboxId, session.name);
      await sb.close();
      await refresh();
    } catch (err) {
      status.content = `failed to kill '${session.name}': ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  select.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
    if (option.value) onOpen(option.value as SandboxDetails);
  });

  const onKeypress = (event: { name: string }) => {
    if (event.name === "q") onQuit();
    else if (event.name === "r") void refresh();
    else if (event.name === "n") onNew();
    else if (event.name === "k") void killSelected();
    else if (event.name === "l") {
      const session = select.getSelectedOption()?.value as SandboxDetails | null;
      if (session) onLogs(session);
    }
  };
  renderer.keyInput.on("keypress", onKeypress);

  void refresh();

  return {
    box,
    setStatus(message: string) {
      status.content = message;
    },
    dispose() {
      renderer.keyInput.off("keypress", onKeypress);
    },
  };
}
