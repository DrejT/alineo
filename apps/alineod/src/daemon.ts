/**
 * Start a whole alineod: the lease, the SDK ledger, memory, rehydrate, the HTTP app and the sweep,
 * in the order they depend on each other.
 *
 * `server.ts` calls this with options read from the environment. A deployer who needs what the
 * environment cannot express (an `authenticate` function that maps API keys to tenants, per-tenant
 * limits, a kill switch) writes their own small entry file and calls this with those options. They
 * do not copy the boot sequence, so it cannot drift from the one alineod itself runs.
 *
 * Call it at most once per process. Configuration that is not in `options` (port aside) still comes
 * from the `ALINEOD_*` environment variables in `config.ts`, which are read on import.
 */
import { getLogger } from "@alineo-labs/logger";
import { LEASE_TTL_MS, PORT, SWEEP_INTERVAL_MS, configWarnings } from "../config";
import "./state/db"; // side effect: open the db, create tables
import { acquireLease, LeaseHeldError } from "./state/lease";
import { connectSdkAdapter } from "./engine/registry";
import { rehydrate } from "./engine/rehydrate";
import { initMemory } from "./engine/memory";
import { createApp, type CreateAppOptions } from "./app";
import { Limits } from "./limits";
import { startSweeper } from "./engine/sweeper";

export interface StartDaemonOptions extends CreateAppOptions {
  /** Port to listen on. Default: `ALINEOD_PORT`. */
  port?: number;
}

export interface Daemon {
  app: ReturnType<typeof createApp>;
  port: number;
  /** Stop listening, stop the sweep and release the lease. Agents keep running; state is durable. */
  stop: () => void;
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<Daemon> {
  const { port = PORT, limits = new Limits(), ...appOptions } = options;
  const log = getLogger("alineod");

  // ../config is evaluated on import, before the logger exists, so it queues its warnings instead.
  for (const warning of configWarnings.splice(0)) log.warn(warning);

  // Before rehydrate: rehydrate reattaches every live agent, and a second instance doing the same
  // would drive them twice. See state/lease.ts.
  let lease;
  try {
    lease = await acquireLease({
      ttlMs: LEASE_TTL_MS,
      onLost: (holder) => {
        log.error("lease taken over by another instance; exiting so agents aren't driven twice", {
          host: holder?.host,
          pid: holder?.pid,
        });
        process.exit(1);
      },
    });
  } catch (err) {
    if (!(err instanceof LeaseHeldError)) throw err;
    log.error(err.message);
    process.exit(1);
  }

  await connectSdkAdapter();
  // Before rehydrate: reconnected agents are handed this store, and a bad path should stop the
  // daemon here rather than on the first spawn.
  initMemory();
  await rehydrate();

  const app = createApp({ ...appOptions, limits }).listen(port);

  // Only when there is something to sweep: a run-age limit, or a way to suspend a tenant.
  const sweeper = limits.needsSweep ? startSweeper(limits, SWEEP_INTERVAL_MS) : undefined;

  const listening = app.server?.port ?? port;
  log.info("listening", {
    url: `http://localhost:${listening}`,
    openapi: "/openapi",
    auth: appOptions.authenticate ? "on" : "none",
    specEnv:
      appOptions.specEnvAllow === undefined
        ? "unrestricted"
        : appOptions.specEnvAllow.length
          ? "allowlist"
          : "none",
  });

  const held = lease;
  return {
    app,
    port: listening,
    stop: () => {
      sweeper?.stop();
      void app.stop();
      held.release();
    },
  };
}
