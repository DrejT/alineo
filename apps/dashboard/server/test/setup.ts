/**
 * Test preload: in-memory databases, a token, a fake alineod on a local port, and mocks for the
 * three modules that would otherwise reach the network (`@alineo-labs/sandbox`, `ai`, and the
 * model provider). Env is set before any server module is imported, since config reads it once.
 */
import { mock } from "bun:test";

process.env.DASHBOARD_DB_PATH = ":memory:";
process.env.DASHBOARD_LEDGER_PATH = ":memory:";
process.env.DASHBOARD_TOKEN = "test-token";
process.env.DASHBOARD_ORIGINS = "http://localhost:4321";
process.env.DASHBOARD_SWARM_PARENT_TIMEOUT_MS = "400";
process.env.DASHBOARD_SWARM_RETRY_MS = "20";

const { startFakeAlineod } = await import("./fake-alineod");
process.env.ALINEOD_URL = startFakeAlineod();

const { FakeSandboxClientClass, fakeGenerateObject } = await import("./fakes");
const { SandboxStatus } = await import("@alineo-labs/core");
mock.module("@alineo-labs/sandbox", () => ({ Sandbox: FakeSandboxClientClass, SandboxStatus }));
mock.module("ai", () => ({ generateObject: fakeGenerateObject }));
// The real provider's languageModel() needs GEMINI_API_KEY. Tests never call a real model
// (generateObject is faked above), so this only has to exist and be callable.
mock.module("@alineo-labs/model-providers", () => ({
  googleProvider: { id: "google", label: "Google (Gemini)", envVar: "GEMINI_API_KEY", languageModel: () => ({}) },
  MODEL_PROVIDERS: [
    { id: "google", label: "Google (Gemini)", envVar: "GEMINI_API_KEY" },
    { id: "groq", label: "Groq", envVar: "GROQ_API_KEY" },
  ],
}));

const { connectLedger } = await import("../ledger");
await connectLedger();
