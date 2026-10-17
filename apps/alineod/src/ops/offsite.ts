/**
 * Full backups in object storage (durability-roadmap M4, 4.2).
 *
 * `backup()` writes a verified directory on the host. This copies it into a `BlobStore` so it
 * survives the host. Litestream covers the three SQLite files continuously. A full backup adds the
 * work dir (results and spec files), which Litestream does not see, and a second, simpler way back
 * if the replica is ever unusable.
 *
 * A backup is `<name>/<relative path>` for every file, plus a `<name>/COMPLETE` manifest uploaded
 * LAST. Anything without the manifest is a half-finished upload and is never offered for restore.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { BlobStore } from "alineo";
import type { BackupResult } from "./backup";

const MANIFEST = "COMPLETE";

interface Manifest {
  files: string[];
  uploadedAt: number;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Upload one local backup directory. Throws on the first failed file and writes no manifest. */
async function uploadBackup(
  store: BlobStore,
  backupDir: string,
  name: string,
): Promise<{ name: string; files: string[] }> {
  const files = walk(backupDir)
    .map((f) => relative(backupDir, f).split(sep).join("/"))
    .sort();
  for (const file of files) await store.put(`${name}/${file}`, join(backupDir, ...file.split("/")));
  const manifest: Manifest = { files, uploadedAt: Date.now() };
  await store.put(`${name}/${MANIFEST}`, new TextEncoder().encode(JSON.stringify(manifest)));
  return { name, files };
}

/** `backup()`'s result in the shape `uploadBackup()` takes. */
export function uploadResult(store: BlobStore, result: BackupResult) {
  const name = result.dir.split(sep).pop() ?? result.dir;
  return uploadBackup(store, result.dir, name);
}

/** Names of the complete backups in the store, newest first. The name sorts by time. */
export async function listBackups(store: BlobStore): Promise<string[]> {
  const blobs = await store.list("");
  const names = new Set<string>();
  for (const b of blobs) {
    const [name, ...rest] = b.key.split("/");
    if (name && rest.join("/") === MANIFEST) names.add(name);
  }
  return [...names].sort().reverse();
}

/** Download a complete backup into `destDir`, keeping its layout. Returns the files written. */
export async function downloadBackup(
  store: BlobStore,
  name: string,
  destDir: string,
  write: (path: string, bytes: Uint8Array) => void | Promise<void>,
): Promise<string[]> {
  const manifest = JSON.parse(
    new TextDecoder().decode(await store.get(`${name}/${MANIFEST}`)),
  ) as Manifest;
  const written: string[] = [];
  for (const file of manifest.files) {
    const target = join(destDir, ...file.split("/"));
    await write(target, await store.get(`${name}/${file}`));
    written.push(target);
  }
  return written;
}

/** Keep the newest `keep` complete backups, delete the rest and any upload that never finished. */
export async function pruneOffsite(
  store: BlobStore,
  keep: number,
  now = Date.now(),
  incompleteGraceMs = 60 * 60_000,
): Promise<string[]> {
  const complete = await listBackups(store);
  const doomedNames = new Set(complete.slice(keep));
  const blobs = await store.list("");
  const doomed: string[] = [];
  for (const b of blobs) {
    const name = b.key.split("/")[0] ?? "";
    const abandoned = !complete.includes(name) && now - b.lastModified > incompleteGraceMs;
    if (doomedNames.has(name) || abandoned) doomed.push(b.key);
  }
  await Promise.all(doomed.map((key) => store.delete(key)));
  return [...new Set(doomed.map((k) => k.split("/")[0] ?? ""))].sort();
}
