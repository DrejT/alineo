import { describe, expect, it } from "bun:test";
import {
  LedgerEvent,
  type IStorageAdapter,
  type LedgerEntry,
  type SandboxHandle,
} from "@alineo-labs/core";
import { reconcileDroppedPermissions } from "../src/agent/factory";

function entry(event: LedgerEvent, payload: unknown): LedgerEntry {
  return { ts: Date.now(), name: "agent", sandboxId: "sb-1", stepIndex: -1, event, payload };
}

function fakeAdapter(events: LedgerEntry[]): IStorageAdapter {
  // eslint-disable-next-line strict-ts/no-chained-type-assertions -- deliberately partial: reconcileDroppedPermissions only calls adapter.readAll()
  return { readAll: async () => events } as unknown as IStorageAdapter;
}

function fakeSandbox(): {
  emitted: Array<{ event: LedgerEvent; payload: unknown }>;
  sb: SandboxHandle;
} {
  const emitted: Array<{ event: LedgerEvent; payload: unknown }> = [];
  // eslint-disable-next-line strict-ts/no-chained-type-assertions -- deliberately partial: reconcileDroppedPermissions only calls sb.emit()
  const sb = {
    emit: async (event: LedgerEvent, _stepIndex: number, payload: unknown) => {
      emitted.push({ event, payload });
    },
  } as unknown as SandboxHandle;
  return { emitted, sb };
}

describe("reconcileDroppedPermissions", () => {
  it("resolves a request with no matching PermissionResolved as dropped, not rejected", async () => {
    const adapter = fakeAdapter([entry(LedgerEvent.PermissionRequested, { requestId: "req-1" })]);
    const { emitted, sb } = fakeSandbox();

    await reconcileDroppedPermissions(adapter, sb, "agent", "sb-1");

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      event: LedgerEvent.PermissionResolved,
      payload: { requestId: "req-1", decision: { kind: "dropped" } },
    });
  });

  it("leaves an already-resolved request alone", async () => {
    const adapter = fakeAdapter([
      entry(LedgerEvent.PermissionRequested, { requestId: "req-1" }),
      entry(LedgerEvent.PermissionResolved, { requestId: "req-1", decision: { kind: "once" } }),
    ]);
    const { emitted, sb } = fakeSandbox();

    await reconcileDroppedPermissions(adapter, sb, "agent", "sb-1");

    expect(emitted).toHaveLength(0);
  });

  it("never throws, even if the adapter read fails", async () => {
    const adapter = fakeAdapter([]);
    adapter.readAll = () => Promise.reject(new Error("disk error"));
    const { emitted, sb } = fakeSandbox();

    await reconcileDroppedPermissions(adapter, sb, "agent", "sb-1");

    expect(emitted).toHaveLength(0);
  });
});
