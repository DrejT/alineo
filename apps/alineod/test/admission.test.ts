/**
 * Backpressure on provisioning (admission-control.md). `ALINEOD_ADMISSION_CONCURRENCY=2` and
 * `ALINEOD_ADMISSION_TIMEOUT_MS=300` are set in setup.ts, small and deterministic rather than the
 * adaptive (host-core-derived) production default, so a couple of fake root runs are enough to
 * exercise real contention.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { call, deferred, events, spec, until } from "./helpers";
import { fakeSdk } from "./fakes";

afterEach(() => fakeSdk.reset());

describe("admission control", () => {
  test("caps concurrent provisioning at ALINEOD_ADMISSION_CONCURRENCY, queues the rest", async () => {
    const gate = deferred();
    fakeSdk.startGate = gate.promise;

    const r1 = await call("POST", "/runs", { spec: spec("root-1") });
    const r2 = await call("POST", "/runs", { spec: spec("root-2") });
    const r3 = await call("POST", "/runs", { spec: spec("root-3") });

    await until(() => fakeSdk.calls.start === 2, "exactly 2 concurrent Alineo.start() calls");
    await Bun.sleep(30); // let a would-be third start show up, if the cap didn't hold
    expect(fakeSdk.calls.start).toBe(2);

    const queued = [r1, r2, r3]
      .map((r) => events(r.body.runId).find((e) => e.event === "agent.admission_queued"))
      .filter((e) => e !== undefined);
    expect(queued).toHaveLength(1); // exactly one of the three is the one that had to wait

    gate.resolve();
    await until(() => fakeSdk.calls.start === 3, "the queued third proceeds once a slot frees");

    for (const r of [r1, r2, r3]) {
      await until(
        async () => (await call("GET", `/agents/${r.body.rootAgentId}`)).body.sandboxId,
        `${r.body.rootAgentId} eventually provisioned`,
      );
    }

    const granted = [r1, r2, r3]
      .map((r) => events(r.body.runId).find((e) => e.event === "agent.admission_granted"))
      .filter((e) => e !== undefined);
    expect(granted).toHaveLength(1); // only the one that queued gets a "granted" event
  });

  test("a request that never gets a slot fails loudly with admission_timeout, not a silent hang", async () => {
    const gate = deferred(); // deliberately never resolved within this test
    fakeSdk.startGate = gate.promise;

    const r1 = await call("POST", "/runs", { spec: spec("root-1") });
    const r2 = await call("POST", "/runs", { spec: spec("root-2") });
    const r3 = await call("POST", "/runs", { spec: spec("root-3") });
    await until(() => fakeSdk.calls.start === 2, "the first two occupy both slots");

    const row = await until(
      async () => {
        const v = await call("GET", `/agents/${r3.body.rootAgentId}`);
        return v.body.outcome ? v.body : null;
      },
      "root-3 to give up waiting",
      2_000,
    );

    expect(row).toMatchObject({ outcome: "admission_timeout" });
    expect(events(r3.body.runId).find((e) => e.event === "agent.admission_timeout")).toMatchObject({
      waitedMs: 300,
    });

    gate.resolve(); // let the other two finish so nothing leaks into the next test
    for (const r of [r1, r2]) {
      await until(
        async () => (await call("GET", `/agents/${r.body.rootAgentId}`)).body.sandboxId,
        `${r.body.rootAgentId} finishes`,
      );
    }
  }, 5_000);
});
