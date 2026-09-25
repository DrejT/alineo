/**
 * `init` — starts OpenSandbox + alineod locally via Docker and writes
 * `alineo.config.json`. Delegates to `@alineo-labs/cli-shared`'s `runInit`, which `alineo init`
 * (`packages/cli/src/commands/init.ts`) also calls — this collects its log lines into an array
 * instead of writing to stdout, since an MCP stdio server's stdout is the JSON-RPC channel, so
 * tool handlers must never `console.log`.
 */
import { runInit } from "@alineo-labs/cli-shared";

export interface InitResult {
  log: string[];
  serverUrl: string;
  alineodUrl: string;
}

export async function init(): Promise<InitResult> {
  const log: string[] = [];
  const { serverUrl, alineodUrl } = await runInit((message) => log.push(message));
  return { log, serverUrl, alineodUrl };
}
