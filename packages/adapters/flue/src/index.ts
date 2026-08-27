import type { SandboxApi, SandboxFactory, FileStat } from "@flue/runtime";
import { createSandboxSessionEnv } from "@flue/runtime";
import type { SandboxHandle } from "@alineo-labs/sandbox";

// POSIX single-quote escaping for shell arguments.
function esc(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise<never>((_, reject) =>
    setTimeout(() => {
      reject(new Error(`exec timed out after ${ms}ms`));
    }, ms),
  );
}

// Encode Uint8Array → base64 string without using Buffer (portable Web API).
function uint8ToBase64(buf: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return btoa(binary);
}

// Decode base64 string → Uint8Array.
function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf;
}

class AlineoSandboxApi implements SandboxApi {
  constructor(private readonly sb: SandboxHandle) {}

  async exec(
    command: string,
    opts?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const run = Promise.resolve(
      this.sb.exec(command, { cwd: opts?.cwd, env: opts?.env, strict: false }),
    );
    if (opts?.timeoutMs == null) return run;
    return Promise.race([run, rejectAfter(Math.ceil(opts.timeoutMs))]);
  }

  readFile(path: string): Promise<string> {
    return this.sb.readFile(path);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    // sb.readFile() decodes bytes as UTF-8 which is lossy for binary files;
    // base64 round-trip via exec preserves arbitrary byte sequences.
    const { stdout } = await this.sb.exec(`base64 -w0 ${esc(path)}`);
    return base64ToUint8(stdout.trim());
  }

  /**
   * Write a file into the sandbox.
   *
   * When `content` is a `Uint8Array`, the bytes are base64-encoded and piped
   * through `base64 -d` in the container. This relies on the shell `ARG_MAX`
   * limit (~2 MB on Linux), so binary writes are capped at roughly **1.5 MB**.
   * For larger binary files, write via string (pre-encoded) or split writes.
   */
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    if (typeof content === "string") {
      await this.sb.writeFile(path, content);
      return;
    }
    const b64 = uint8ToBase64(content);
    await this.sb.exec(`echo '${b64}' | base64 -d > ${esc(path)}`);
  }

  async stat(path: string): Promise<FileStat> {
    const { stdout, exitCode } = await this.sb.exec(`stat -c '%F|%s|%Y' ${esc(path)}`, {
      strict: false,
    });
    if (exitCode !== 0) throw new Error(`stat: cannot stat '${path}': No such file or directory`);
    const [typeStr, sizeStr, mtimeStr] = stdout.trim().split("|");
    return {
      isFile: typeStr === "regular file",
      isDirectory: typeStr === "directory",
      isSymbolicLink: typeStr === "symbolic link",
      size: parseInt(sizeStr, 10),
      mtime: new Date(parseInt(mtimeStr, 10) * 1000),
    };
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.sb.listDirectory(path, { depth: 1 });
    // FileInfo has `path` (full path) but no `name` field; extract the final segment.
    const norm = path.endsWith("/") ? path.slice(0, -1) : path;
    const prefix = norm + "/";
    return entries
      .filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes("/"))
      .map((e) => e.path.slice(prefix.length))
      .filter(Boolean);
  }

  async exists(path: string): Promise<boolean> {
    const { exitCode } = await this.sb.exec(`test -e ${esc(path)}`, { strict: false });
    return exitCode === 0;
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.sb.exec(`mkdir ${opts?.recursive ? "-p " : ""}${esc(path)}`);
  }

  async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const flags = [opts?.recursive && "-r", opts?.force && "-f"].filter(Boolean).join(" ");
    await this.sb.exec(`rm ${flags ? flags + " " : ""}${esc(path)}`);
  }
}

/**
 * Flue `SandboxFactory` backed by a alineo `SandboxHandle`.
 *
 * Pass an already-created `SandboxHandle` (lifecycle is the caller's responsibility —
 * the adapter never calls `sb.close()`). Returns a factory suitable for
 * Flue's `sandbox` agent option.
 *
 * @example
 * ```ts
 * // src/sandboxes/alineo.ts  (Flue adapter file)
 * import { alineo } from "@alineo-labs/flue";
 * import { Sandbox } from "@alineo-labs/sandbox";
 * import { SQLiteAdapter } from "@alineo-labs/sqlite";
 *
 * const client = new Sandbox({ baseUrl: "http://localhost:8080", adapter: new SQLiteAdapter("./alineo.db") });
 *
 * export default alineo(
 *   await client.sandbox({ image: "node:22", resources: { cpu: "500m", memory: "256Mi" } }),
 * );
 * ```
 */
export function alineo(sandbox: SandboxHandle, opts?: { cwd?: string }): SandboxFactory {
  return {
    createSessionEnv(_: { id: string }) {
      return Promise.resolve(
        createSandboxSessionEnv(new AlineoSandboxApi(sandbox), opts?.cwd ?? "/"),
      );
    },
  };
}
