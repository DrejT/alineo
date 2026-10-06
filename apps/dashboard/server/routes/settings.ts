/**
 * Read-only effective configuration of the dashboard server and its link to alineod. Model
 * provider and storage choices are code/env-level, so this shows what is in effect and does not
 * pretend a form can change it.
 */
import { Elysia } from "elysia";
import { MODEL_PROVIDERS } from "@alineo-labs/model-providers";
import { alineodReachable } from "../alineod";
import { config } from "../config";
import { defaultResources } from "../swarms/planner";

export const settingsRoutes = new Elysia({ prefix: "/settings" }).get("/", async () => ({
  storage: { adapter: "sqlite", dbPath: config.dbPath, ledgerPath: config.ledgerPath },
  alineod: { url: config.alineodUrl, reachable: await alineodReachable() },
  defaultResources: defaultResources(),
  authEnabled: Boolean(config.token),
  modelProviders: MODEL_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    envVar: p.envVar,
    configured: Boolean(process.env[p.envVar]),
  })),
}));
