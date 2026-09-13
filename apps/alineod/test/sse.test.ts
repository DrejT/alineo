/** GET /runs/:runId/events — replay, Last-Event-ID, live delivery, and persisted vs ephemeral events. */
import { afterEach, describe, expect, test } from "bun:test";
import { app, call, deferred, events, startRun, until } from "./helpers";
import { fakeSdk } from "./fakes";

afterEach(() => fakeSdk.reset());

interface Frame {
  id?: number;
  event: string;
  data: Record<string, unknown>;
}

/** Open the stream and collect parsed frames until `stop` returns true. */
async function collect(
  runId: string,
  stop: (frames: Frame[]) => boolean,
  opts: { lastEventId?: number; afterOpen?: () => Promise<void> } = {},
): Promise<Frame[]> {
  const headers: Record<string, string> = {};
  if (opts.lastEventId !== undefined) headers["last-event-id"] = String(opts.lastEventId);
  const res = await app.handle(
    new Request(`http://alineod.test/runs/${runId}/events`, { headers }),
  );
  expect(res.headers.get("content-type")).toBe("text/event-stream");

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = "";
  const afterOpen = opts.afterOpen?.();
  const deadline = Date.now() + 5_000;

  try {
    while (!stop(frames)) {
      if (Date.now() > deadline)
        throw new Error(`stream timed out; got ${frames.map((f) => f.event).join(",")}`);
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (raw.startsWith(":")) continue; // heartbeat
        const frame: Partial<Frame> = {};
        for (const line of raw.split("\n")) {
          const [key, ...rest] = line.split(": ");
          const value = rest.join(": ");
          if (key === "id") frame.id = Number(value);
          if (key === "event") frame.event = value;
          if (key === "data") frame.data = JSON.parse(value);
        }
        frames.push(frame as Frame);
      }
    }
  } finally {
    await reader.cancel();
    await afterOpen;
  }
  return frames;
}

test("replays the run's persisted history on connect, in seq order", async () => {
  const { runId, rootAgentId } = await startRun({ prompt: "hi" });
  await until(async () => (await call("GET", `/agents/${rootAgentId}`)).body.state === "done");
  const ledger = events(runId);

  const frames = await collect(runId, (f) => f.length >= ledger.length);
  expect(frames.map((f) => f.id)).toEqual(ledger.map((e) => e.seq));
  expect(frames[0]).toMatchObject({ event: "run_started", data: { agentId: null, runId } });
  expect(frames.find((f) => f.event === "agent_ended")?.data).toMatchObject({
    agentId: rootAgentId,
    outcome: "success",
  });
});

test("Last-Event-ID replays only what came after it", async () => {
  const { runId, rootAgentId } = await startRun({ prompt: "hi" });
  await until(async () => (await call("GET", `/agents/${rootAgentId}`)).body.state === "done");
  const ledger = events(runId);
  const cut = ledger[2]!.seq;

  const frames = await collect(runId, (f) => f.length >= ledger.length - 3, { lastEventId: cut });
  expect(frames.map((f) => f.id)).toEqual(ledger.filter((e) => e.seq > cut).map((e) => e.seq));
});

describe("live delivery", () => {
  test("lifecycle events arrive as they happen", async () => {
    const { runId, rootAgentId } = await startRun();
    const history = events(runId).length;

    const frames = await collect(runId, (f) => f.some((x) => x.event === "agent_steered"), {
      afterOpen: async () => {
        await Bun.sleep(20);
        await call("POST", `/agents/${rootAgentId}/steer`, { message: "go left" });
      },
    });
    expect(frames.length).toBe(history + 1);
    expect(frames.at(-1)).toMatchObject({
      event: "agent_steered",
      data: { agentId: rootAgentId, message: "go left" },
    });
    expect(frames.at(-1)!.id).toBeGreaterThan(frames.at(-2)!.id!);
  });

  test("milestone harness events carry an id and are persisted; text deltas don't", async () => {
    const { runId, rootAgentId } = await startRun();
    const gate = deferred();

    const frames = await collect(runId, (f) => f.some((x) => x.event === "tool_start"), {
      afterOpen: async () => {
        await Bun.sleep(20);
        const root = fakeSdk.sandboxes.get(
          (await call("GET", `/agents/${rootAgentId}`)).body.sandboxId,
        )!;
        root.turn = {
          events: [
            { type: "text", text: "thinking" },
            { type: "tool_start", toolName: "bash" },
          ],
          gate: gate.promise,
        };
        await call("POST", `/agents/${rootAgentId}/prompt`, { text: "run ls" });
      },
    });

    const text = frames.find((f) => f.event === "text")!;
    const tool = frames.find((f) => f.event === "tool_start")!;
    expect(text).toMatchObject({ data: { agentId: rootAgentId, text: "thinking" } });
    expect(text.id).toBeUndefined();
    expect(tool.id).toBeNumber();
    expect(tool.data).toMatchObject({ agentId: rootAgentId, toolName: "bash" });

    const persisted = events(runId).map((e) => e.event);
    expect(persisted).toContain("tool_start");
    expect(persisted).not.toContain("text");
    gate.resolve();
  });
});
