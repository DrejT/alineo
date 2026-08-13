import type { CliCommand } from "./types.js";

/**
 * Every alineo subcommand's name/group/usage/summary, plus a `run` that dynamically
 * imports its implementation. The metadata here is intentionally duplicated from each
 * command file's own `xCommand` export (e.g. `initCommand` in init.ts) rather than
 * statically imported — a static import would pull in that command's full dependency
 * graph (e.g. spawn.ts drags in `@alineo-labs/agent`, `alineo`, `@alineo-labs/sqlite`) on *every* CLI
 * invocation just to print help text, which measured ~3x slower for something as
 * trivial as `alineo --version`. Duplicating a couple of plain strings per command is a
 * much smaller risk than that: a mismatch would show up immediately in the printed
 * help output, unlike the old free-floating prose block that could silently drift from
 * the switch statement's actual behavior with no visual signal at all.
 *
 * Adding a command: create the command file with its own `xCommand` export (see
 * types.ts), then add one entry here whose `variants` matches it.
 */
export const commands: CliCommand[] = [
  {
    name: "init",
    group: "sdk",
    variants: [{ usage: "alineo init", summary: "Start OpenSandbox locally via Docker" }],
    run: async (argv) => (await import("./init.js")).initCommand.run(argv),
  },
  {
    name: "add",
    group: "sdk",
    variants: [
      { usage: "alineo add <url> [--name <n>]", summary: "Fetch and save an agent spec locally" },
    ],
    run: async (argv) => (await import("./add.js")).addCommand.run(argv),
  },
  {
    name: "list",
    group: "sdk",
    variants: [{ usage: "alineo list", summary: "List saved agent specs" }],
    run: async (argv) => (await import("./list.js")).listCommand.run(argv),
  },
  {
    name: "remove",
    group: "sdk",
    variants: [{ usage: "alineo remove <name>", summary: "Remove a saved agent spec" }],
    run: async (argv) => (await import("./remove.js")).removeCommand.run(argv),
  },
  {
    name: "spawn",
    group: "agent",
    variants: [
      {
        usage: "alineo spawn <spec>",
        summary: "Start a fresh agent sandbox, print its name, exit",
      },
      {
        usage: "alineo spawn <spec> --prompt <msg>",
        summary: "Start it, send one prompt, print the reply, exit",
      },
    ],
    run: async (argv) => (await import("./spawn.js")).spawnCommand.run(argv),
  },
  {
    name: "prompt",
    group: "agent",
    variants: [
      {
        usage: "alineo prompt <sandbox-id> <msg>",
        summary: "Send one prompt to a running sandbox, print the reply",
      },
    ],
    run: async (argv) => (await import("./prompt.js")).promptCommand.run(argv),
  },
  {
    name: "fork",
    group: "agent",
    variants: [
      {
        usage: "alineo fork <name> <child-spec>",
        summary: "Fork a running session's own live sandbox into a new child",
      },
    ],
    run: async (argv) => (await import("./fork.js")).forkCommand.run(argv),
  },
  {
    name: "agents",
    group: "agent",
    variants: [{ usage: "alineo agents [--json]", summary: "List running agent sessions" }],
    run: async (argv) => (await import("./agents.js")).agentsCommand.run(argv),
  },
  {
    name: "kill",
    group: "agent",
    variants: [{ usage: "alineo kill <sandbox-id>", summary: "Stop a sandbox" }],
    run: async (argv) => (await import("./kill.js")).killCommand.run(argv),
  },
  {
    name: "logs",
    group: "agent",
    variants: [
      { usage: "alineo logs <name> [--json]", summary: "Print ledger events for a session" },
    ],
    run: async (argv) => (await import("./logs.js")).logsCommand.run(argv),
  },
  {
    name: "telemetry",
    group: "sdk",
    variants: [
      { usage: "alineo telemetry status", summary: "Show whether telemetry is enabled" },
      { usage: "alineo telemetry enable", summary: "Enable anonymous usage telemetry" },
      { usage: "alineo telemetry disable", summary: "Disable anonymous usage telemetry" },
    ],
    run: async (argv) => (await import("./telemetry.js")).telemetryCommand.run(argv),
  },
];
