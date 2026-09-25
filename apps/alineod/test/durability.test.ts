/** What "committed" means on disk: the ledger's sync settings and the result blob's write. */
import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/state/db";
import { readResult, writeResult } from "../src/engine/results";
import { WORK_DIR } from "../config";

test("the ledger runs WAL with synchronous = FULL", () => {
  expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  // 2 = FULL. Pinned in db.ts, so a SQLite build with a weaker default can't loosen it.
  expect(db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
});

test("writeResult replaces the blob atomically and leaves no temp file", () => {
  writeResult("agent-durable", "first");
  writeResult("agent-durable", "second");

  expect(readResult("agent-durable")).toBe("second");
  const leftovers = readdirSync(join(WORK_DIR, "results")).filter((f) => f.endsWith(".tmp"));
  expect(leftovers).toEqual([]);
});

test("a null result is stored as an empty blob, not skipped", () => {
  writeResult("agent-empty", null);
  expect(existsSync(join(WORK_DIR, "results", "agent-empty.md"))).toBe(true);
  expect(readResult("agent-empty")).toBe("");
});
