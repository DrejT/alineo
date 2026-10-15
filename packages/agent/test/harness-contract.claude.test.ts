import { afterAll } from "bun:test";
import { defineHarnessContract } from "./harness-contract/contract";
import { startClaudeBridge, stopClaudeBridges } from "./fixtures/claude-bridge-harness";

/**
 * Binds the contract to `ClaudeCodeAdapter`, end to end: the real adapter, the real built
 * bridge in a real `node` process, and a stand-in for the Agent SDK. It proves the adapter
 * and bridge keep the contract and map the SDK's documented messages. It does not prove the
 * real SDK sends those messages: that needs a live run with a key.
 */
afterAll(stopClaudeBridges);

defineHarnessContract({
  name: "claude-code (stub sdk)",
  create: (scenario) => startClaudeBridge(scenario),
  expectedCapabilities: { steer: false, followUp: false, fork: true, permissions: true },
});
