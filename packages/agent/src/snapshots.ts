import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_PROVIDER_ID } from "@alineo-labs/core";
import type { AgentSpec } from "./schema";

export interface AgentSnapshotRecord {
  specName: string;
  setupHash: string;
  /**
   * The sandbox provider that owns `snapshotId`. A snapshot id is meaningless to any other
   * provider, so it is part of the cache key. Absent on records written before this field
   * existed, which all came from OpenSandbox.
   */
  provider?: string;
  /** OpenSandbox snapshot ID returned by `sb.checkpoint()`. Pass to `client.restoreSnapshot()`. */
  snapshotId: string;
  createdAt: number;
}

/**
 * Hash of the fields that require re-installing the harness or rerunning
 * setup: harness, harnessVersion, packages, and setup. Excludes env (hot-reloadable),
 * model/provider (harness flags only), and cosmetic fields.
 *
 * The hashed object deliberately keeps the **old** key names. This is a cache key, not a
 * vocabulary surface — nobody reads it — and changing the keys would change every existing
 * snapshot's hash, so the `harness` rename would silently cost every user a ~90s rebuild of
 * every agent instead of a ~3s snapshot restore. The values are what identify the install;
 * the key spelling is incidental.
 */
export function computeSetupHash(spec: AgentSpec): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        cli: spec.harness,
        cliVersion: spec.harnessVersion ?? "latest",
        packages: [...(spec.packages ?? [])].sort(),
        setup: spec.setup ?? [],
      }),
    )
    .digest("hex")
    .slice(0, 12);
}

/** Derive the agent-snapshots.json path from the ledger adapter path. */
export function snapshotsPath(adapterPath: string): string {
  return `${dirname(adapterPath)}/agent-snapshots.json`;
}

/** File-backed store for agent snapshot records, keyed by specName + setupHash. */
export class AgentSnapshotStore {
  constructor(private readonly path: string) {}

  private async _read(): Promise<Record<string, AgentSnapshotRecord>> {
    try {
      return JSON.parse(await readFile(this.path, "utf-8")) as Record<string, AgentSnapshotRecord>;
    } catch {
      return {};
    }
  }

  private async _write(data: Record<string, AgentSnapshotRecord>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(data, null, 2));
  }

  /**
   * OpenSandbox keeps the key it always had, so every existing file keeps working. Another
   * provider's records get its id as a prefix, so two providers sharing one file never read
   * or replace each other's snapshot ids.
   */
  private _key(specName: string, setupHash: string, provider: string) {
    return provider === DEFAULT_PROVIDER_ID
      ? `${specName}:${setupHash}`
      : `${provider}:${specName}:${setupHash}`;
  }

  async get(
    specName: string,
    setupHash: string,
    provider: string = DEFAULT_PROVIDER_ID,
  ): Promise<AgentSnapshotRecord | null> {
    const data = await this._read();
    return data[this._key(specName, setupHash, provider)] ?? null;
  }

  /**
   * Writes are read-modify-write on one file. Two at once (several specs finishing their setup
   * together, as when alineod restores a whole swarm onto a new machine) would each read the old
   * file and the second write would drop the first record. This chain runs them one at a time.
   * It guards one process: a second process on the same file is not supported.
   */
  private writing: Promise<unknown> = Promise.resolve();

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writing.then(fn, fn);
    this.writing = run.catch(() => {});
    return run;
  }

  save(record: AgentSnapshotRecord): Promise<void> {
    return this.serialized(async () => {
      const data = await this._read();
      const provider = record.provider ?? DEFAULT_PROVIDER_ID;
      // Remove stale records for the same spec (different hash = old packages), for this provider
      // only. Another provider's snapshot of the same spec is still valid.
      for (const k of Object.keys(data)) {
        if (
          data[k].specName === record.specName &&
          (data[k].provider ?? DEFAULT_PROVIDER_ID) === provider
        ) {
          delete data[k];
        }
      }
      data[this._key(record.specName, record.setupHash, provider)] = record;
      await this._write(data);
    });
  }

  /** Remove all snapshot records for the given spec name. */
  delete(specName: string): Promise<void> {
    return this.serialized(async () => {
      const data = await this._read();
      for (const k of Object.keys(data)) {
        if (data[k].specName === specName) delete data[k];
      }
      await this._write(data);
    });
  }

  async list(): Promise<AgentSnapshotRecord[]> {
    return Object.values(await this._read());
  }
}
