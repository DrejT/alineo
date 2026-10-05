/**
 * The dashboard server's own SQLite file (workflow runs, remembered sandbox resources). It is
 * never alineod's database: alineod's is single-writer behind a process lease.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL");
