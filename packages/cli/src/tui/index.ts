import { createCliRenderer, BoxRenderable } from "@opentui/core";
import type { SandboxDetails } from "@alineo-labs/sandbox";
import { Alineo } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { readConfig } from "../config.js";
import { createDashboardView, type DashboardView } from "./dashboard.js";
import { createChatView, type ChatView } from "./chat.js";
import { createNewSessionView, type NewSessionView } from "./new-session.js";
import { createLogsView, type LogsView } from "./logs.js";

type View = DashboardView | ChatView | NewSessionView | LogsView;

export async function launchTui(): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const root = new BoxRenderable(renderer, { id: "tui-root", width: "100%", height: "100%" });
  renderer.root.add(root);

  let current: View | null = null;

  function mount(view: View): void {
    if (current) {
      root.remove(current.box);
      current.dispose();
    }
    current = view;
    root.add(view.box);
  }

  function quit(): void {
    renderer.destroy();
    process.exit(0);
  }

  function showDashboard(initialStatus?: string): void {
    const view = createDashboardView(
      renderer,
      (session) => void openSession(session),
      quit,
      showNewSession,
      (session) => {
        mount(
          createLogsView(renderer, session, () => {
            showDashboard();
          }),
        );
      },
    );
    mount(view);
    if (initialStatus) view.setStatus(initialStatus);
  }

  function showNewSession(): void {
    mount(
      createNewSessionView(
        renderer,
        (specPath) => void launchNewAgent(specPath),
        () => {
          showDashboard();
        },
      ),
    );
  }

  async function openSession(session: SandboxDetails): Promise<void> {
    const config = await readConfig();
    const adapter = new SQLiteAdapter(config.adapterPath);
    try {
      const agent = await Alineo.resume(session.sandboxId, {
        adapter,
        specPath: `${config.agentsDir}/${session.name}.json`,
      });
      mount(
        createChatView(renderer, agent, () => {
          showDashboard();
        }),
      );
    } catch (err) {
      showDashboard(
        `failed to open '${session.name}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function launchNewAgent(specPath: string): Promise<void> {
    const config = await readConfig();
    const adapter = new SQLiteAdapter(config.adapterPath);
    try {
      // Alineo.load() no longer does its own file I/O (see #184) -- read the spec ourselves.
      const spec = (await Bun.file(specPath).json()) as Record<string, unknown>;
      const agent = await Alineo.load(spec, { adapter });
      mount(
        createChatView(renderer, agent, () => {
          showDashboard();
        }),
      );
    } catch (err) {
      showDashboard(
        `failed to start '${specPath}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  showDashboard();
  renderer.start();
}
