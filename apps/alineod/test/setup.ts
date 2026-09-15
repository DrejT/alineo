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

const { FakeAlineo } = await import("./fakes");
mock.module("alineo", () => ({ Alineo: FakeAlineo }));
