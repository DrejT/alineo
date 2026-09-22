import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentSpec } from "./schema";

export interface AgentSnapshotRecord {
  specName: string;
  setupHash: string;
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

  private _key(specName: string, setupHash: string) {
    return `${specName}:${setupHash}`;
  }

  async get(specName: string, setupHash: string): Promise<AgentSnapshotRecord | null> {
    const data = await this._read();
    return data[this._key(specName, setupHash)] ?? null;
  }

  async save(record: AgentSnapshotRecord): Promise<void> {
    const data = await this._read();
    // Remove stale records for the same spec (different hash = old packages).
    for (const k of Object.keys(data)) {
      if (data[k].specName === record.specName) delete data[k];
    }
    data[this._key(record.specName, record.setupHash)] = record;
    await this._write(data);
  }

  /** Remove all snapshot records for the given spec name. */
  async delete(specName: string): Promise<void> {
    const data = await this._read();
    for (const k of Object.keys(data)) {
      if (data[k].specName === specName) delete data[k];
    }
    await this._write(data);
  }

  async list(): Promise<AgentSnapshotRecord[]> {
    return Object.values(await this._read());
  }
}
