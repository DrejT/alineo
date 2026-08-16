#!/usr/bin/env bun
import { commands } from "./commands/registry.js";
import type { CliCommand } from "./commands/types.js";
import { recordTuiLaunch, withTelemetry } from "./telemetry.js";

const [, , cmd, ...argv] = process.argv;

const HELP_NOTES = `  Add --json to spawn/prompt/fork/agents/logs for machine-readable output.
  Add --depth <n> to spawn/fork to override the spec's "spawnDepth" — the
  nesting-depth budget for further forks.
  Add --max <n> to spawn/fork to override the spec's "maxAgents" — a separate,
  optional ceiling on total descendants for this lineage (not coordinated
  across sibling branches spawned in parallel).
  Add --spec <path> to prompt to skip the ledger lookup for the spec file
  (needed when the sandbox's own creation event lives in a different ledger,
  e.g. a child spawned via 'alineo fork' from inside another sandbox).`;

const GROUPS: { key: CliCommand["group"]; label: string }[] = [
  { key: "sdk", label: "SDK — OpenSandbox config and the local spec cache:" },
  { key: "agent", label: "Agent — session lifecycle:" },
];

function printHelp(): void {
  console.log(`alineo — alineo agent registry CLI\n`);
  console.log(`  alineo                              Launch the interactive TUI (in a terminal)`);
  console.log(`  alineo --version                    Print the installed version`);

  for (const { key, label } of GROUPS) {
    const groupCommands = commands.filter((c) => c.group === key);
    const width =
      Math.max(...groupCommands.flatMap((c) => c.variants.map((v) => v.usage.length))) + 2;
    console.log(`\n${label}`);
    for (const c of groupCommands) {
      for (const v of c.variants) {
        console.log(`  ${v.usage.padEnd(width)}${v.summary}`);
      }
    }
  }

  console.log(`\n${HELP_NOTES}`);
}

async function main(): Promise<void> {
  // Bare `alineo` in an interactive terminal launches the TUI; piped/scripted
  // invocations with no subcommand (no TTY) fall through to the help text below.
  if (!cmd && process.stdout.isTTY) {
    await recordTuiLaunch();
    const { launchTui } = await import("./tui/index.js");
    await launchTui();
    return;
  }

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    const { version } = await import("../package.json");
    console.log(version);
    return;
  }

  const found = commands.find((c) => c.name === cmd);
  if (found) {
    await withTelemetry(found.name, argv, () => found.run(argv));
    // spawn/fork/prompt deliberately leave their sandbox running (that's the whole point --
    // `alineo agents`/`alineo prompt <id>` interact with it afterward), so we can't clean up
    // by closing the Agent/Sandbox object: that would delete the very sandbox the command just
    // reported. But the SDK's underlying exec client keeps a connection open to support further
    // calls on that same object, which otherwise leaves this process's event loop non-empty
    // forever. Force-exiting here only ends *this* CLI invocation -- it has no effect on the
    // remote sandbox, which keeps running exactly as intended.
    process.exit(0);
  }

  printHelp();
  if (cmd) process.exit(1);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
