import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The gate reads its policy from process.env.ALINEO_PI_CONFIG (falling back to
// /etc/alineo-pi.json). Point it at a temp file we rewrite per-case, then import the
// extension once — loadPolicy() re-reads the file on every gate(pi) call.
const dir = mkdtempSync(join(tmpdir(), "alineo-gate-"));
const configPath = join(dir, "alineo-pi.json");
process.env.ALINEO_PI_CONFIG = configPath;

type GateResult = { block: true; reason: string } | undefined;

let gate: (pi: unknown) => void;

beforeAll(async () => {
  // `: string` so TS doesn't try to resolve a declaration file for the plain-.js extension.
  const modPath: string = "../src/adapters/pi-permission-gate.js";
  const mod = (await import(modPath)) as { default: (pi: unknown) => void };
  gate = mod.default;
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setPolicy(permissions: unknown) {
  writeFileSync(configPath, JSON.stringify({ permissions }));
}

type Fn = (...a: unknown[]) => unknown;
type ToolCallFn = (
  event: { toolName: string; input: unknown },
  ctx: unknown,
) => Promise<GateResult>;

function makePi(activeTools = ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
  const handlers: Record<string, Fn[]> = {};
  const pi = {
    handlers,
    active: [...activeTools] as string[],
    on(name: string, fn: Fn) {
      (handlers[name] ??= []).push(fn);
    },
    getActiveTools() {
      return pi.active;
    },
    setActiveTools(tools: string[]) {
      pi.active = tools;
    },
  };
  return pi;
}

/** Drive one tool_call through the gate. `select` is what ctx.ui.select resolves to. */
async function call(
  pi: ReturnType<typeof makePi>,
  toolName: string,
  input: unknown,
  select?: (title: string) => unknown,
): Promise<{ result: GateResult; selectCalls: string[] }> {
  const selectCalls: string[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      // eslint-disable-next-line typescript/require-await
      select: async (title: string) => {
        selectCalls.push(title);
        return select ? select(title) : undefined;
      },
    },
  };
  const handler = pi.handlers.tool_call[0] as ToolCallFn;
  const result = await handler({ toolName, input }, ctx);
  return { result, selectCalls };
}

describe("pi-permission-gate — toolset", () => {
  it("restrictToTools intersects the visible toolset", () => {
    setPolicy({ default: "ask", rules: [], restrictToTools: ["read", "grep"] });
    const pi = makePi();
    gate(pi);
    expect(pi.active.sort()).toEqual(["grep", "read"]);
  });

  it("disabledTools is removed from the visible toolset and denied at call time", async () => {
    setPolicy({ default: "allow", rules: [], disabledTools: ["bash"] });
    const pi = makePi();
    gate(pi);
    expect(pi.active).not.toContain("bash");
    const { result } = await call(pi, "bash", { command: "ls" });
    expect(result).toMatchObject({ block: true });
  });

  it("re-applies the toolset on session_start", () => {
    setPolicy({ default: "ask", rules: [], restrictToTools: ["read"] });
    const pi = makePi();
    gate(pi);
    pi.active = ["read", "write", "bash"]; // simulate Pi re-registering tools
    for (const fn of pi.handlers.session_start) fn();
    expect(pi.active).toEqual(["read"]);
  });
});

describe("pi-permission-gate — decisions", () => {
  it("allow rule → runs (undefined)", async () => {
    setPolicy({ default: "ask", rules: [{ tool: "read", action: "allow" }] });
    const pi = makePi();
    gate(pi);
    const { result } = await call(pi, "read", { path: "/etc/hosts" });
    expect(result).toBeUndefined();
  });

  it("deny rule → blocks with a reason", async () => {
    setPolicy({ default: "ask", rules: [{ tool: "bash", pattern: "*rm -rf*", action: "deny" }] });
    const pi = makePi();
    gate(pi);
    const { result } = await call(pi, "bash", { command: "x && rm -rf /" });
    expect(result).toMatchObject({ block: true });
  });

  it("classify → allows a read-only bash command without asking", async () => {
    setPolicy({ default: "ask", rules: [{ tool: "bash", action: "classify" }] });
    const pi = makePi();
    gate(pi);
    const { result, selectCalls } = await call(pi, "bash", { command: "ls -la | grep foo" });
    expect(result).toBeUndefined();
    expect(selectCalls).toHaveLength(0);
  });

  it("classify → asks for a writing bash command", async () => {
    setPolicy({ default: "ask", rules: [{ tool: "bash", action: "classify" }] });
    const pi = makePi();
    gate(pi);
    const { result, selectCalls } = await call(pi, "bash", { command: "npm install" }, () =>
      JSON.stringify({ verdict: "reject", feedback: "no" }),
    );
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("no");
    expect(selectCalls[0]).toStartWith("ALINEO_PERM ");
  });

  it("ask + allow-once → runs; ask + reject → blocks", async () => {
    setPolicy({ default: "ask", rules: [] });
    const pi = makePi();
    gate(pi);
    const ok = await call(pi, "write", { path: "/a" }, () =>
      JSON.stringify({ verdict: "allow", scope: "once" }),
    );
    expect(ok.result).toBeUndefined();
    const no = await call(pi, "write", { path: "/b" }, () => JSON.stringify({ verdict: "reject" }));
    expect(no.result).toMatchObject({ block: true });
  });

  it("ask + allow-always → subsequent identical calls skip the prompt", async () => {
    setPolicy({ default: "ask", rules: [] });
    const pi = makePi();
    gate(pi);
    const first = await call(pi, "bash", { command: "make" }, () =>
      JSON.stringify({ verdict: "allow", scope: "always" }),
    );
    expect(first.result).toBeUndefined();
    const second = await call(pi, "bash", { command: "make" });
    expect(second.result).toBeUndefined();
    expect(second.selectCalls).toHaveLength(0);
  });

  it("cancelled/timed-out prompt (undefined) → blocks", async () => {
    setPolicy({ default: "ask", rules: [] });
    const pi = makePi();
    gate(pi);
    const { result } = await call(pi, "bash", { command: "make" }, () => undefined);
    expect(result).toMatchObject({ block: true });
  });

  it("rate_limit → allows up to the ceiling, then blocks", async () => {
    setPolicy({
      default: "ask",
      rules: [{ tool: "bash", action: "rate_limit", limit: { count: 2, windowMs: 10_000 } }],
    });
    const pi = makePi();
    gate(pi);
    expect((await call(pi, "bash", { command: "a" })).result).toBeUndefined();
    expect((await call(pi, "bash", { command: "a" })).result).toBeUndefined();
    expect((await call(pi, "bash", { command: "a" })).result).toMatchObject({ block: true });
  });
});
