import type { FileInfo } from "@alineo-labs/opensandbox";
import type { SandboxInternal } from "./internal";

/** Write a file into the sandbox. */
export async function writeFile(sb: SandboxInternal, path: string, content: string): Promise<void> {
  const ec = await sb.getExecClient();
  await ec.uploadFile(path, content);
}

/** Write raw bytes into the sandbox — for binary content (a gzip tarball, an image) that
 * `writeFile`'s string-typed signature would push a caller toward corrupting via a lossy
 * decode/re-encode round trip before it ever reaches this function. */
export async function writeFileBytes(
  sb: SandboxInternal,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const ec = await sb.getExecClient();
  // Re-copied into a fresh, plain ArrayBuffer-backed Uint8Array -- TS's stricter
  // ArrayBuffer-vs-ArrayBufferLike typing (newer lib defs) rejects a caller's Uint8Array
  // whose backing buffer type parameter isn't narrowed to exactly ArrayBuffer (e.g. a Buffer,
  // which types its buffer as ArrayBufferLike to also allow SharedArrayBuffer). The copy is
  // cheap next to the upload itself and keeps this function's own parameter type the plain,
  // unparameterized `Uint8Array` every caller already has in hand.
  await ec.uploadFile(path, new Uint8Array(bytes));
}

/**
 * Read a file from the sandbox as raw bytes — no `TextDecoder`, so binary content (a gzip
 * tarball, an image) round-trips intact. `readFile()` below is this plus a UTF-8 decode; a
 * caller that needs the decode uses that instead, not this one re-encoded.
 */
export async function readFileBytes(sb: SandboxInternal, path: string): Promise<Uint8Array> {
  const ec = await sb.getExecClient();
  const stream = await ec.downloadFile(path);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** Read a file from the sandbox as a UTF-8 string. */
export async function readFile(sb: SandboxInternal, path: string): Promise<string> {
  return new TextDecoder().decode(await readFileBytes(sb, path));
}

/** Delete a file from the sandbox. */
export async function deleteFile(sb: SandboxInternal, path: string): Promise<void> {
  const ec = await sb.getExecClient();
  await ec.deleteFile(path);
}

/** Move or rename a file inside the sandbox. */
export async function moveFile(sb: SandboxInternal, from: string, to: string): Promise<void> {
  const ec = await sb.getExecClient();
  await ec.moveFile(from, to);
}

/** List files in a directory inside the sandbox. */
export async function listDirectory(
  sb: SandboxInternal,
  path: string,
  opts: { depth?: number } = {},
) {
  const ec = await sb.getExecClient();
  return ec.listDirectory(path, opts.depth);
}

/** Search for files matching a glob pattern inside the sandbox. */
export async function searchFiles(sb: SandboxInternal, pattern: string, path = "/") {
  const ec = await sb.getExecClient();
  return ec.searchFiles(pattern, path);
}

/** Create a directory (and parents) inside the sandbox. */
export async function createDirectory(sb: SandboxInternal, path: string): Promise<void> {
  const ec = await sb.getExecClient();
  await ec.createDirectory(path);
}

/** Delete a directory inside the sandbox. */
export async function deleteDirectory(sb: SandboxInternal, path: string): Promise<void> {
  const ec = await sb.getExecClient();
  await ec.deleteDirectory(path);
}

/** Return metadata for a file or directory (size, type, mode, timestamps). */
export async function getFileInfo(sb: SandboxInternal, path: string): Promise<FileInfo> {
  const ec = await sb.getExecClient();
  return ec.getFileInfo(path);
}

/**
 * Replace substrings in one or more files inside the sandbox.
 *
 * More efficient than `readFile` → string replace → `writeFile` for targeted edits.
 */
export async function replaceInFiles(
  sb: SandboxInternal,
  replacements: Array<{ path: string; old: string; new: string }>,
): Promise<void> {
  const ec = await sb.getExecClient();
  await ec.replaceInFiles(replacements);
}
