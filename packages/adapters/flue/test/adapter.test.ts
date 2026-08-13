import { describe, expect, it, mock } from "bun:test";
import type { Sandbox } from "alineo";

// ── Module mock ──────────────────────────────────────────────────────────────
// Must be set up before the import of the module under test so bun can hoist it.

let capturedApi: ReturnType<typeof buildApi> | null = null;
mock.module("@flue/runtime", () => ({
  createSandboxSessionEnv: (api: ReturnType<typeof buildApi>, cwd: string) => {
    capturedApi = api;
    return { _cwd: cwd };
  },
}));

import { alineo } from "../src/index.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

type ExecResult = { stdout: string; stderr: string; exitCode: number };
type FileInfoStub = {
  path: string;
  type: string;
  size: number;
  mode: number;
  modified_at: string;
  created_at: string;
  owner: string;
  group: string;
};

type SandboxStub = {
  exec: (cmd: string, opts?: any) => PromiseLike<ExecResult>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  listDirectory: (path: string, opts?: any) => Promise<FileInfoStub[]>;
};

function makeStub(overrides: Partial<SandboxStub> = {}): Sandbox {
  return {
    exec:
      overrides.exec ?? ((_cmd, _opts) => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 })),
    readFile: overrides.readFile ?? ((_path) => Promise.resolve("")),
    writeFile: overrides.writeFile ?? ((_path, _content) => Promise.resolve()),
    listDirectory: overrides.listDirectory ?? ((_path, _opts) => Promise.resolve([])),
  } as unknown as Sandbox;
}

function buildApi(sb: Sandbox) {
  return {} as any; // placeholder type; real shape captured at runtime
}

async function getApi(sb: Sandbox): Promise<any> {
  capturedApi = null;
  const factory = alineo(sb);
  await factory.createSessionEnv({ id: "test-ctx" });
  return capturedApi!;
}

// ── exec ─────────────────────────────────────────────────────────────────────

describe("exec", () => {
  it("delegates command, cwd, env and strict:false to sb.exec", async () => {
    let lastCall: any;
    const sb = makeStub({
      exec: (cmd, opts) => {
        lastCall = { cmd, opts };
        return Promise.resolve({ stdout: "hello", stderr: "", exitCode: 0 });
      },
    });
    const api = await getApi(sb);
    const result = await api.exec("echo hi", { cwd: "/tmp", env: { X: "1" } });
    expect(lastCall.cmd).toBe("echo hi");
    expect(lastCall.opts.cwd).toBe("/tmp");
    expect(lastCall.opts.env).toEqual({ X: "1" });
    expect(lastCall.opts.strict).toBe(false);
    expect(result).toEqual({ stdout: "hello", stderr: "", exitCode: 0 });
  });

  it("returns non-zero exitCode without throwing", async () => {
    const sb = makeStub({
      exec: () => Promise.resolve({ stdout: "", stderr: "err", exitCode: 1 }),
    });
    const api = await getApi(sb);
    const { exitCode } = await api.exec("false");
    expect(exitCode).toBe(1);
  });

  it("rejects after timeoutMs with the ceiling applied", async () => {
    const sb = makeStub({ exec: () => new Promise(() => {}) }); // never resolves
    const api = await getApi(sb);
    await expect(api.exec("sleep 999", { timeoutMs: 10 })).rejects.toThrow("timed out after 10ms");
  });

  it("rounds timeoutMs up via Math.ceil", async () => {
    let rejectMsg = "";
    const sb = makeStub({ exec: () => new Promise(() => {}) });
    const api = await getApi(sb);
    await api.exec("x", { timeoutMs: 1.3 }).catch((e: Error) => {
      rejectMsg = e.message;
    });
    expect(rejectMsg).toBe("exec timed out after 2ms"); // ceil(1.3) = 2
  });

  it("runs without timeout when timeoutMs is omitted", async () => {
    const sb = makeStub({ exec: () => Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }) });
    const api = await getApi(sb);
    expect(await api.exec("echo ok")).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
  });
});

// ── readFile ─────────────────────────────────────────────────────────────────

describe("readFile", () => {
  it("delegates to sb.readFile", async () => {
    const sb = makeStub({ readFile: () => Promise.resolve("file-content") });
    const api = await getApi(sb);
    expect(await api.readFile("/etc/hosts")).toBe("file-content");
  });
});

// ── readFileBuffer ────────────────────────────────────────────────────────────

describe("readFileBuffer", () => {
  it("runs base64 -w0 and decodes the output to Uint8Array", async () => {
    const original = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    let execCmd = "";
    const sb = makeStub({
      exec: (cmd) => {
        execCmd = cmd;
        return Promise.resolve({ stdout: btoa("Hello") + "\n", stderr: "", exitCode: 0 });
      },
    });
    const api = await getApi(sb);
    const result: Uint8Array = await api.readFileBuffer("/bin/file");
    expect(execCmd).toContain("base64 -w0");
    expect(execCmd).toContain("'/bin/file'");
    expect(result).toEqual(original);
  });

  it("handles path with single quotes", async () => {
    let execCmd = "";
    const sb = makeStub({
      exec: (cmd) => {
        execCmd = cmd;
        return Promise.resolve({ stdout: btoa("x"), stderr: "", exitCode: 0 });
      },
    });
    const api = await getApi(sb);
    await api.readFileBuffer("/it's/a/path");
    expect(execCmd).toContain("'/it'\\''s/a/path'");
  });
});

// ── writeFile ─────────────────────────────────────────────────────────────────

describe("writeFile", () => {
  it("delegates string content to sb.writeFile", async () => {
    let wrote: any;
    const sb = makeStub({
      writeFile: (p, c) => {
        wrote = { p, c };
        return Promise.resolve();
      },
    });
    const api = await getApi(sb);
    await api.writeFile("/out.txt", "hello");
    expect(wrote).toEqual({ p: "/out.txt", c: "hello" });
  });

  it("base64-encodes Uint8Array content and pipes through base64 -d", async () => {
    let execCmd = "";
    const sb = makeStub({
      exec: (cmd) => {
        execCmd = cmd;
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    });
    const api = await getApi(sb);
    const data = new Uint8Array([0x01, 0x02, 0x03]);
    await api.writeFile("/bin/out", data);
    expect(execCmd).toContain("base64 -d");
    expect(execCmd).toContain("'/bin/out'");
    expect(execCmd).toContain(btoa(String.fromCharCode(1, 2, 3)));
  });
});

// ── stat ──────────────────────────────────────────────────────────────────────

describe("stat", () => {
  function makeStat(typeStr: string, size = "42", mtime = "1700000000") {
    return makeStub({
      exec: () =>
        Promise.resolve({ stdout: `${typeStr}|${size}|${mtime}\n`, stderr: "", exitCode: 0 }),
    });
  }

  it("identifies a regular file", async () => {
    const api = await getApi(makeStat("regular file"));
    const s = await api.stat("/file.txt");
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
  });

  it("identifies a directory", async () => {
    const api = await getApi(makeStat("directory"));
    const s = await api.stat("/dir");
    expect(s.isFile).toBe(false);
    expect(s.isDirectory).toBe(true);
  });

  it("identifies a symbolic link", async () => {
    const api = await getApi(makeStat("symbolic link"));
    const s = await api.stat("/link");
    expect(s.isSymbolicLink).toBe(true);
  });

  it("parses size and mtime", async () => {
    const api = await getApi(makeStat("regular file", "1024", "1700000000"));
    const s = await api.stat("/f");
    expect(s.size).toBe(1024);
    expect(s.mtime).toEqual(new Date(1700000000 * 1000));
  });

  it("throws when the path does not exist (non-zero exit)", async () => {
    const sb = makeStub({
      exec: () => Promise.resolve({ stdout: "", stderr: "no such file", exitCode: 1 }),
    });
    const api = await getApi(sb);
    await expect(api.stat("/nope")).rejects.toThrow("No such file or directory");
  });
});

// ── readdir ───────────────────────────────────────────────────────────────────

describe("readdir", () => {
  it("returns direct child names extracted from full paths", async () => {
    const sb = makeStub({
      listDirectory: () =>
        Promise.resolve([
          {
            path: "/base/a",
            type: "file",
            size: 0,
            mode: 0o644,
            modified_at: "",
            created_at: "",
            owner: "",
            group: "",
          },
          {
            path: "/base/b",
            type: "directory",
            size: 0,
            mode: 0o755,
            modified_at: "",
            created_at: "",
            owner: "",
            group: "",
          },
        ]),
    });
    const api = await getApi(sb);
    expect(await api.readdir("/base")).toEqual(["a", "b"]);
  });

  it("filters out deeper entries if depth returns grandchildren", async () => {
    const sb = makeStub({
      listDirectory: () =>
        Promise.resolve([
          {
            path: "/d/child",
            type: "file",
            size: 0,
            mode: 0,
            modified_at: "",
            created_at: "",
            owner: "",
            group: "",
          },
          {
            path: "/d/child/grandchild",
            type: "file",
            size: 0,
            mode: 0,
            modified_at: "",
            created_at: "",
            owner: "",
            group: "",
          },
        ]),
    });
    const api = await getApi(sb);
    expect(await api.readdir("/d")).toEqual(["child"]);
  });

  it("handles trailing slash on path", async () => {
    const sb = makeStub({
      listDirectory: () =>
        Promise.resolve([
          {
            path: "/base/x",
            type: "file",
            size: 0,
            mode: 0,
            modified_at: "",
            created_at: "",
            owner: "",
            group: "",
          },
        ]),
    });
    const api = await getApi(sb);
    expect(await api.readdir("/base/")).toEqual(["x"]);
  });
});

// ── exists ────────────────────────────────────────────────────────────────────

describe("exists", () => {
  it("returns true when test -e exits 0", async () => {
    const sb = makeStub({ exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }) });
    const api = await getApi(sb);
    expect(await api.exists("/etc/hosts")).toBe(true);
  });

  it("returns false when test -e exits non-zero", async () => {
    const sb = makeStub({ exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 1 }) });
    const api = await getApi(sb);
    expect(await api.exists("/no/such/path")).toBe(false);
  });
});

// ── mkdir ─────────────────────────────────────────────────────────────────────

describe("mkdir", () => {
  it("calls mkdir without -p by default", async () => {
    let cmd = "";
    const sb = makeStub({
      exec: (c) => {
        cmd = c;
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    });
    const api = await getApi(sb);
    await api.mkdir("/new/dir");
    expect(cmd).toMatch(/^mkdir '/);
    expect(cmd).not.toContain("-p");
  });

  it("passes -p when recursive is true", async () => {
    let cmd = "";
    const sb = makeStub({
      exec: (c) => {
        cmd = c;
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    });
    const api = await getApi(sb);
    await api.mkdir("/deep/path", { recursive: true });
    expect(cmd).toContain("mkdir -p");
  });
});

// ── rm ────────────────────────────────────────────────────────────────────────

describe("rm", () => {
  it("calls rm with no flags by default", async () => {
    let cmd = "";
    const sb = makeStub({
      exec: (c) => {
        cmd = c;
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    });
    const api = await getApi(sb);
    await api.rm("/tmp/file");
    expect(cmd).toMatch(/^rm '/);
  });

  it("passes -r for recursive", async () => {
    let cmd = "";
    const sb = makeStub({
      exec: (c) => {
        cmd = c;
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    });
    const api = await getApi(sb);
    await api.rm("/dir", { recursive: true });
    expect(cmd).toContain("-r");
    expect(cmd).not.toContain("-f");
  });

  it("passes -f for force", async () => {
    let cmd = "";
    const sb = makeStub({
      exec: (c) => {
        cmd = c;
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    });
    const api = await getApi(sb);
    await api.rm("/file", { force: true });
    expect(cmd).toContain("-f");
    expect(cmd).not.toContain("-r");
  });

  it("passes both -r and -f", async () => {
    let cmd = "";
    const sb = makeStub({
      exec: (c) => {
        cmd = c;
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    });
    const api = await getApi(sb);
    await api.rm("/dir", { recursive: true, force: true });
    expect(cmd).toContain("-r");
    expect(cmd).toContain("-f");
  });
});

// ── alineo factory ──────────────────────────────────────────────────────────────

describe("alineo factory", () => {
  it("passes cwd '/' by default to createSandboxSessionEnv", async () => {
    const sb = makeStub();
    const factory = alineo(sb);
    const env = (await factory.createSessionEnv({ id: "x" })) as any;
    expect(env._cwd).toBe("/");
  });

  it("forwards custom cwd option", async () => {
    const sb = makeStub();
    const factory = alineo(sb, { cwd: "/workspace" });
    const env = (await factory.createSessionEnv({ id: "x" })) as any;
    expect(env._cwd).toBe("/workspace");
  });
});
