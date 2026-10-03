/**
 * Test preload. Runs before any test file imports alineod code, so:
 *
 * 1. alineod's config (read once, at import time) points at a throwaway temp directory.
 * 2. The `alineo` SDK is replaced by the scriptable fake in fakes.ts — no OpenSandbox, no model.
 */
import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "alineod-test-"));
process.env.ALINEOD_DB_PATH = join(dir, "alineod.db");
process.env.ALINEOD_SDK_LEDGER_PATH = join(dir, "sdk-ledger.db");
process.env.ALINEOD_WORK_DIR = join(dir, "work");
process.env.ALINEOD_PROMPT_INACTIVITY_MS = "8000";
// Catch-up timings, shortened so tests that follow a turn by polling finish quickly.
process.env.ALINEOD_TURN_MAX_MS = "2000"; // unpaused time before catch-up gives up
process.env.ALINEOD_CATCH_UP_POLL_MS = "25";
process.env.ALINEOD_STATE_PROBE_TIMEOUT_MS = "100";
process.env.ALINEOD_RESUME_BRIDGE_TIMEOUT_MS = "100";
process.env.ALINEOD_REATTACH_RETRY_DELAY_MS = "10";
// Small and deterministic rather than the adaptive (host-core-derived) production default, so
// admission.test.ts can exercise real contention with just a couple of fake agents.
process.env.ALINEOD_ADMISSION_CONCURRENCY = "2";
process.env.ALINEOD_ADMISSION_TIMEOUT_MS = "300";

const { FakeAlineo, FakeSandboxClientClass, fakeGenerateObject } = await import("./fakes");
const { SandboxStatus } = await import("@alineo-labs/core");
mock.module("alineo", () => ({ Alineo: FakeAlineo }));
mock.module("@alineo-labs/sandbox", () => ({ Sandbox: FakeSandboxClientClass, SandboxStatus }));
mock.module("ai", () => ({ generateObject: fakeGenerateObject }));
// The real provider's languageModel() requires GEMINI_API_KEY; tests never call the real model
// (generateObject is faked above), so this just needs to exist and be callable.
mock.module("@alineo-labs/model-providers", () => ({
  googleProvider: { id: "google", label: "Google (Gemini)", envVar: "GEMINI_API_KEY", languageModel: () => ({}) },
  MODEL_PROVIDERS: [
    { id: "google", label: "Google (Gemini)", envVar: "GEMINI_API_KEY" },
    { id: "groq", label: "Groq", envVar: "GROQ_API_KEY" },
  ],
}));

// The sandboxes/workflows subsystem's `sdkAdapter` is the real `SQLiteAdapter` (only the
// `alineo`/`@alineo-labs/sandbox` SDK classes are faked, not storage) — it needs its migrations
// run once before any test touches it, same as `server.ts` does for the real process.
const { sdkAdapter } = await import("../src/engine/registry");
await sdkAdapter.connect?.();
