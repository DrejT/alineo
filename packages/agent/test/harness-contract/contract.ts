import { describe, expect, it } from "bun:test";
import {
  requireHarnessCapability,
  type FakeScenario,
  type HarnessAdapter,
  type HarnessCapability,
  type HarnessEvent,
} from "../../src/harness";
import type { CaseId, HarnessBinding } from "./binding";

export type { HarnessBinding } from "./binding";

async function collect(turn: AsyncIterable<HarnessEvent>, ms = 3000): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  const run = (async () => {
    for await (const e of turn) out.push(e);
  })();
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          `turn did not end within ${ms}ms. Events so far: ${out.map((e) => e.type).join(",")}`,
        ),
      );
    }, ms);
  });
  await Promise.race([run, timeout]);
  return out;
}

const dones = (evs: HarnessEvent[]) => evs.filter((e) => e.type === "done");

/** The contract every turn keeps: one `done`, and it is last. */
function expectOneTerminalEvent(evs: HarnessEvent[]): void {
  expect(dones(evs)).toHaveLength(1);
  expect(evs.at(-1)?.type).toBe("done");
}

/**
 * Register the conformance cases for one harness. Call once per binding file.
 *
 * Cases that do not apply to a harness (a permission case for one with
 * `capabilities.permissions: false`) are skipped by capability, never silently passed.
 */
export function defineHarnessContract(binding: HarnessBinding): void {
  const label = (id: CaseId, text: string) => `${id}: ${text}`;

  function define(id: CaseId, text: string, body: () => Promise<void>): void {
    const reason = binding.skip?.[id];
    if (reason !== undefined) {
      it.skip(`${label(id, text)} (skipped: ${reason})`, () => {});
      return;
    }
    it(label(id, text), body, 15_000);
  }

  async function adapterFor(scenario: FakeScenario): Promise<HarnessAdapter> {
    return binding.create(scenario);
  }

  describe(`harness contract: ${binding.name}`, () => {
    define("text-turn", "a turn yields its text and ends with one done", async () => {
      const a = await adapterFor({ kind: "text", text: "hello world" });
      const evs = await collect(a.runTurn({ message: "hi" }));
      const text = evs.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
      expect(text).toContain("hello world");
      expectOneTerminalEvent(evs);
      expect(evs.at(-1)).toMatchObject({ type: "done", reason: "completed" });
    });

    define("tool-events-pair", "every tool_end follows a tool_start with the same id", async () => {
      const a = await adapterFor({ kind: "tool", toolName: "bash", result: "42" });
      const evs = await collect(a.runTurn({ message: "run it" }));
      const started = new Set<string>();
      let ended = 0;
      for (const e of evs) {
        if (e.type === "tool_start") started.add(e.toolCallId);
        if (e.type === "tool_end") {
          expect(started.has(e.toolCallId)).toBe(true);
          ended++;
        }
      }
      expect(started.size).toBeGreaterThan(0);
      expect(ended).toBe(started.size);
      expectOneTerminalEvent(evs);
    });

    define("abort-ends-turn", "abort ends a running turn with one done, aborted", async () => {
      const a = await adapterFor({ kind: "hang" });
      const run = collect(a.runTurn({ message: "wait" }));
      await new Promise((r) => setTimeout(r, 50));
      await a.abort();
      const evs = await run;
      expectOneTerminalEvent(evs);
      expect(evs.at(-1)).toMatchObject({ type: "done", reason: "aborted" });
    });

    define("failure-is-events", "a failure is an error event then done, not a throw", async () => {
      const a = await adapterFor({ kind: "fail", message: "the model is unavailable" });
      const evs = await collect(a.runTurn({ message: "x" }));
      expect(evs.some((e) => e.type === "error")).toBe(true);
      expectOneTerminalEvent(evs);
      expect(evs.at(-1)).toMatchObject({ type: "done", reason: "error" });
    });

    define("steer-between-turns", "steer with no turn running throws, never queues", async () => {
      const a = await adapterFor({ kind: "text", text: "x" });
      if (!a.capabilities.steer) {
        expect(typeof a.steer).toBe("undefined");
        return;
      }
      expect(typeof a.steer).toBe("function");
      let threw = false;
      try {
        await a.steer?.("go left");
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });

    define(
      "capabilities-match-methods",
      "a capability is true exactly when its method exists",
      async () => {
        const a = await adapterFor({ kind: "text", text: "x" });
        expect(typeof a.steer === "function").toBe(a.capabilities.steer);
        expect(typeof a.followUp === "function").toBe(a.capabilities.followUp);
        expect(typeof a.forkAt === "function").toBe(a.capabilities.fork);
        for (const [cap, want] of Object.entries(binding.expectedCapabilities ?? {})) {
          expect(a.capabilities[cap as HarnessCapability], cap).toBe(want);
        }
      },
    );

    define(
      "false-capability-refused",
      "requireHarnessCapability refuses every capability declared false",
      async () => {
        const a = await adapterFor({ kind: "text", text: "x" });
        for (const [cap, on] of Object.entries(a.capabilities)) {
          if (on) {
            expect(() => {
              requireHarnessCapability(a, cap as HarnessCapability);
            }).not.toThrow();
          } else {
            expect(() => {
              requireHarnessCapability(a, cap as HarnessCapability);
            }).toThrow(a.id);
          }
        }
      },
    );

    async function permissionRun(decision: "allow" | "reject") {
      const a = await adapterFor({ kind: "permission", tool: "bash", target: "rm -rf build" });
      const evs: HarnessEvent[] = [];
      const run = (async () => {
        for await (const e of a.runTurn({ message: "clean up" })) evs.push(e);
      })();
      const start = Date.now();
      while (!evs.some((e) => e.type === "permission_request")) {
        if (Date.now() - start > 3000) throw new Error("no permission_request was raised");
        await new Promise((r) => setTimeout(r, 20));
      }
      const req = evs.find((e) => e.type === "permission_request");
      if (req?.type !== "permission_request") throw new Error("unreachable");
      const pending = await a.listPendingPermissions();
      expect(pending.map((p) => p.requestId)).toContain(req.requestId);
      await a.resolvePermission(
        req.requestId,
        decision === "allow" ? { kind: "once" } : { kind: "reject", feedback: "not now" },
      );
      await Promise.race([
        run,
        new Promise<never>((_, rej) => {
          setTimeout(() => {
            rej(new Error("turn did not end"));
          }, 3000);
        }),
      ]);
      return { evs, req };
    }

    define("permission-deny-blocks", "a rejected call does not run, and is reported", async () => {
      const a = await adapterFor({ kind: "text", text: "x" });
      if (!a.capabilities.permissions) return;
      const { evs, req } = await permissionRun("reject");
      expect(
        evs.some((e) => e.type === "permission_resolved" && e.requestId === req.requestId),
      ).toBe(true);
      // No tool finished successfully after the rejection.
      expect(evs.some((e) => e.type === "tool_end" && !e.isError)).toBe(false);
      expectOneTerminalEvent(evs);
    });

    define("permission-allow-runs", "an allowed call runs to completion", async () => {
      const a = await adapterFor({ kind: "text", text: "x" });
      if (!a.capabilities.permissions) return;
      const { evs } = await permissionRun("allow");
      expect(evs.some((e) => e.type === "tool_end" && !e.isError)).toBe(true);
      expectOneTerminalEvent(evs);
    });
  });
}
