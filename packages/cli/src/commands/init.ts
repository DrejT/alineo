import { runInit } from "@alineo-labs/cli-shared";
import type { CliCommand } from "./types.js";

export async function init(): Promise<void> {
  await runInit(console.log);
}

export const initCommand: CliCommand = {
  name: "init",
  group: "sdk",
  variants: [{ usage: "alineo init", summary: "Start OpenSandbox and alineod locally via Docker" }],
  run: async () => {
    await init();
  },
};
