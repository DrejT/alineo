import { afterAll } from "bun:test";
import { defineHarnessContract } from "./harness-contract/contract";
import { startCodexBridge, stopCodexBridges } from "./fixtures/codex-bridge-harness";

/**
 * Binds the contract to `CodexAdapter`, end to end: the real adapter, the real built bridge
 * in a real `node` process, and a stand-in for `codex app-server` that speaks the documented
 * JSON-RPC. It does not prove the real binary behaves the same: that needs a live run.
 */
afterAll(stopCodexBridges);

defineHarnessContract({
  name: "codex (stub app-server)",
  create: (scenario) => startCodexBridge(scenario),
  expectedCapabilities: {
    steer: true,
    followUp: false,
    fork: true,
    compact: true,
    permissions: true,
  },
});
