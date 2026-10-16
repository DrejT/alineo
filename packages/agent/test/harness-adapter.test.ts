import { afterEach, describe, expect, it } from "bun:test";
import { PiAdapter } from "../src/adapters/pi";
import {
  createHarness,
  FakeHarness,
  registeredHarnesses,
  requireHarnessCapability,
  type HarnessEvent,
  type HarnessSandbox,
} from "../src/harness";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fakeSandbox(): HarnessSandbox {
  return {
    exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    proxy: () => Promise.resolve({ url: "http://fake-bridge", headers: {} }),
    writeFile: () => Promise.resolve(),
  };
}

async function started(): Promise<PiAdapter> {
  const a = createHarness("pi");
  await a.start(fakeSandbox());
  return a;
}

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

/** A fetch that answers `/prompt` with `chunks`, and `/abort` with an ack. */
function bridge(chunks: string[], opts: { hold?: Promise<void> } = {}): void {
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/abort")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, data: null }), { status: 200 }),
        );
      }
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
          if (opts.hold) await opts.hold;
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    },
    { preconnect: () => {} },
  );
}

async function collect(it: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const doneCount = (evs: HarnessEvent[]) => evs.filter((e) => e.type === "done").length;

describe("PiAdapter as a HarnessAdapter", () => {
  it("declares an id and capabilities", () => {
    const a = createHarness("pi");
    expect(a.id).toBe("pi");
    expect(a.capabilities.steer).toBe(true);
  });

  it("ends a normal turn with exactly one done, last", async () => {
    bridge([
      frame({ type: "agent_start" }),
      frame({ type: "text", text: "hi" }),
      frame({ type: "agent_end", messages: [] }),
    ]);
    const evs = await collect((await started()).runTurn({ message: "x" }));
    expect(evs.map((e) => e.type)).toEqual(["run_start", "text", "done"]);
    expect(evs.at(-1)).toMatchObject({ type: "done", reason: "completed" });
  });

  it("turns a bridge error frame into error then done, and does not throw", async () => {
    bridge([frame({ error: "no API key for provider" })]);
    const evs = await collect((await started()).runTurn({ message: "x" }));
    expect(evs.map((e) => e.type)).toEqual(["error", "done"]);
    expect(evs[0]).toMatchObject({ type: "error" });
    expect((evs[0] as { message: string }).message).toContain("no API key");
    expect(evs.at(-1)).toMatchObject({ type: "done", reason: "error" });
  });

  it("ends an aborted turn with one done, reason aborted", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    bridge([frame({ type: "agent_start" })], { hold });
    const a = await started();
    const run = collect(a.runTurn({ message: "x" }));
    await a.abort();
    release();
    const evs = await run;
    expect(doneCount(evs)).toBe(1);
    expect(evs.at(-1)).toMatchObject({ type: "done", reason: "aborted" });
  });

  it("reads a stream that ends with no result as aborted, never as completed", async () => {
    bridge([frame({ type: "agent_start" })]);
    const evs = await collect((await started()).runTurn({ message: "x" }));
    expect(doneCount(evs)).toBe(1);
    expect(evs.at(-1)).toMatchObject({ type: "done", reason: "aborted" });
  });

  it("completes a streamingBehavior message once it is accepted", async () => {
    bridge([]);
    const evs = await collect(
      (await started()).runTurn({ message: "go left", streamingBehavior: "steer" }),
    );
    expect(evs).toEqual([{ type: "done", reason: "completed" }]);
  });
});

describe("harness registry", () => {
  it("creates a PiAdapter for pi, a new one each time", () => {
    expect(createHarness("pi")).toBeInstanceOf(PiAdapter);
    expect(createHarness("pi")).not.toBe(createHarness("pi"));
    expect(registeredHarnesses()).toEqual(["pi", "claude-code", "codex"]);
  });

  it("refuses an unregistered id with SPEC_INVALID", () => {
    expect(() => {
      createHarness("nope" as "pi");
    }).toThrow(/Unknown harness "nope"/);
    try {
      createHarness("nope" as "pi");
    } catch (e) {
      expect((e as { code: string }).code).toBe("SPEC_INVALID");
    }
  });
});

describe("requireHarnessCapability", () => {
  it("passes a declared capability and refuses an undeclared one, naming both", () => {
    const adapter = {
      id: "x",
      capabilities: { ...createHarness("pi").capabilities, steer: false },
    };
    expect(() => {
      requireHarnessCapability(adapter, "compact");
    }).not.toThrow();
    try {
      requireHarnessCapability(adapter, "steer");
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
      expect((e as Error).message).toBe("The x harness does not support steer");
    }
  });
});

describe("Alineo.harness() and the Pi-only guard", () => {
  // The Alineo class has a private constructor and needs a live sandbox; the guard it
  // relies on is `pi()`, which takes anything with an `adapter`.
  it("pi() hands back a PiAdapter and refuses any other harness, naming both", async () => {
    const { pi } = await import("../src/agent/pi");
    const real = createHarness("pi");
    expect(pi({ adapter: real }, "exportHtml")).toBe(real);

    const other = new FakeHarness({ kind: "text", text: "x" });
    try {
      pi({ adapter: other }, "exportHtml");
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toMatchObject({
        code: "CAPABILITY_UNSUPPORTED",
        details: { operation: "exportHtml", harness: "fake" },
      });
      expect((e as Error).message).toBe("The fake harness does not support exportHtml");
    }
  });
});
