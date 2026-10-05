/**
 * The substrate ledger (`IStorageAdapter`) every sandbox this server creates writes to. It is a
 * separate file from alineod's SDK ledger, so the two processes never write the same SQLite file.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SQLiteAdapter } from "@alineo-labs/sqlite";
import { config } from "./config";

if (config.ledgerPath !== ":memory:") mkdirSync(dirname(config.ledgerPath), { recursive: true });

export const ledger = new SQLiteAdapter(config.ledgerPath);

export async function connectLedger(): Promise<void> {
  await ledger.connect?.();
}
