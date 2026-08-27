import type { FileInfo } from "@alineo-labs/opensandbox";
import type { SandboxInternal } from "./internal";

/** Write a file into the sandbox. */
export async function writeFile(sb: SandboxInternal, path: string, content: string): Promise<void> {
  const ec = await sb.getExecClient();
  await ec.uploadFile(path, content);
}

/** Read a file from the sandbox as a UTF-8 string. */
export async function readFile(sb: SandboxInternal, path: string): Promise<string> {
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
  return new TextDecoder().decode(merged);
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
