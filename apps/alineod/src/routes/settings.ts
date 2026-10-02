/**
 * Read-only effective configuration. Storage adapter choice, model provider, and concurrency
 * limits are all code/env-level in this codebase today (PLAN.md §1) — there's no existing
 * mechanism to make them runtime-configurable, so this surfaces what's actually in effect
 * rather than pretending a settings form can change it.
 */
import { Elysia } from "elysia";
import { MODEL_PROVIDERS } from "@alineo-labs/model-providers";
import { ADMISSION_CONCURRENCY, DB_PATH, SDK_LEDGER_PATH } from "../../config";
import { defaultResources } from "../engine/swarm-planner";

export const settingsRoutes = new Elysia({ prefix: "/settings" }).get("/", () => ({
  storage: { adapter: "sqlite", dbPath: DB_PATH, sdkLedgerPath: SDK_LEDGER_PATH },
  admissionConcurrency: ADMISSION_CONCURRENCY,
  defaultResources: defaultResources(),
  dashboardAuthEnabled: Boolean(process.env.ALINEOD_DASHBOARD_TOKEN),
  modelProviders: MODEL_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    envVar: p.envVar,
    configured: Boolean(process.env[p.envVar]),
  })),
}));
