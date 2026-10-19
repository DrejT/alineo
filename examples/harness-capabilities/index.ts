/**
 * Demonstrates the harness interface: what each agent harness can do, declared up front.
 *   1. registeredHarnesses() + createHarness() — pi, claude-code and codex
 *   2. capabilities                            — steer, followUp, fork, compact, permissions ...
 *   3. an unknown harness                      — SPEC_INVALID, with a hint naming the real ones
 *   4. requireHarnessCapability()              — a call the harness cannot do is refused first
 *
 * Needs nothing running: this reads declarations, it starts no sandbox and no model.
 */
import { createHarness, registeredHarnesses, requireHarnessCapability } from "alineo";

console.log("── 1 + 2. every harness, and what it declares ───────────────");
for (const id of registeredHarnesses()) {
  const harness = createHarness(id as "pi" | "claude-code" | "codex");
  const yes = Object.entries(harness.capabilities)
    .filter(([, on]) => on)
    .map(([name]) => name);
  const no = Object.entries(harness.capabilities)
    .filter(([, on]) => !on)
    .map(([name]) => name);
  console.log(`${id.padEnd(12)} can: ${yes.join(", ")}`);
  console.log(`${"".padEnd(12)} cannot: ${no.join(", ") || "-"}`);
}

console.log("\n── 3. an unknown harness ────────────────────────────────────");
try {
  createHarness("gemini" as never);
} catch (e) {
  const err = e as Error & { code?: string; hint?: string };
  console.log(`${err.code}: ${err.message}`);
  console.log(`hint: ${err.hint}`);
}

console.log("\n── 4. refused before anything is sent ───────────────────────");
const claude = createHarness("claude-code");
try {
  requireHarnessCapability(claude, "steer");
} catch (e) {
  const err = e as Error & { code?: string };
  console.log(`${err.code}: ${err.message}`);
}
