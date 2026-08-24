import type { ExecClient } from "@alineo-labs/opensandbox";
import type { LedgerEvent } from "../ledger";
import type { SandboxDeps } from "./types";

/**
 * Narrow surface that `files.ts`/`lifecycle.ts`/`observability.ts` need from
 * `SandboxCore` — deliberately not exported from the package barrel, so it
 * never becomes public API even though it's a real exported interface within
 * the package. `exec()`/`execCode()`/`createSession()` stay on `SandboxCore`
 * directly since they own `_seq`/`replayCache` most directly; splitting them
 * out would just add indirection without reducing coupling.
 */
export interface SandboxInternal {
  readonly sandboxId: string;
  readonly name: string;
  readonly deps: SandboxDeps;
  readonly openSessionClosers: Set<() => Promise<void>>;
  getExecClient(): Promise<ExecClient>;
  emit(event: LedgerEvent, stepIndex: number, payload?: unknown): Promise<void>;
  waitForRunning(timeoutMs?: number): Promise<void>;
  waitForSnapshot(snapshotId: string, timeoutMs?: number): Promise<void>;
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  isClosed(): boolean;
  setClosed(closed: boolean): void;
  clearExecClient(): void;
  disposeExecClient(): void;
}
