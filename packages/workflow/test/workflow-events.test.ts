import { describe, expect, it, vi } from "vitest";
import { Sandbox } from "@alineo-labs/sandbox";
import { workflow, type WorkflowEvent } from "../src/index.ts";

function fakeClient(readFileBytes = vi.fn().mockResolvedValue(new Uint8Array([7]))) {
  const handle = {
    exec: vi.fn().mockImplementation(() =>
      Object.assign(Promise.resolve({ stdout: "ok\n", stderr: "", exitCode: 0 }), {
        stdout: function* () {
          yield "ok\n";
        },
      }),
    ),
    readFileBytes,
    close: vi.fn().mockResolvedValue(undefined),
  };
  // A real Sandbox instance with only sandbox() replaced: no server is contacted.
  const client: Sandbox = Object.assign(Object.create(Sandbox.prototype) as Sandbox, {
    sandbox: vi.fn().mockResolvedValue(handle),
  });
  return { client, handle };
}

const opts = { image: "node:22-slim", resources: { cpu: "500m", memory: "256Mi" } };

describe("workflow(client, { onEvent })", () => {
  it("wraps step events in workflow.started and workflow.completed", async () => {
    const { client } = fakeClient();
    const events: WorkflowEvent[] = [];
    const { vars } = await workflow(client, { onEvent: (e) => events.push(e) })
      .sandbox(opts, (sb) => {
        sb.exec("echo ok", { as: "out" });
        sb.readFileBytes("/r", "r");
      })
      .result();

    expect(vars).toEqual({ out: "ok", r: new Uint8Array([7]) });
    expect(events.map((e) => e.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
  });

  it("numbers steps across sandboxes and reports workflow.failed", async () => {
    const { client } = fakeClient(vi.fn().mockRejectedValue(new Error("gone")));
    const events: WorkflowEvent[] = [];
    await expect(
      workflow(client, { onEvent: (e) => events.push(e) })
        .sandbox(opts, (sb) => sb.exec("a"))
        .sandbox(opts, (sb) => sb.readFileBytes("/r", "r"))
        .result(),
    ).rejects.toThrow("gone");

    const started = events.filter((e) => e.type === "step.started");
    expect(started.map((e) => e.index)).toEqual([0, 1]);
    expect(events.at(-1)).toMatchObject({ type: "workflow.failed", error: "gone" });
  });
});
