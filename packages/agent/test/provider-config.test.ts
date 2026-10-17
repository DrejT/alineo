import { describe, expect, it } from "bun:test";
import type { IStorageAdapter } from "@alineo-labs/core";
import { loadAgent } from "../src/agent/factory";
import type { AlineoAgentConfig } from "../src/config";

const config = (provider: string): AlineoAgentConfig => ({
  provider,
  serverUrl: "http://127.0.0.1:8080",
  apiKey: "",
  useServerProxy: true,
  adapterPath: "./.alineo/ledger.db",
  agentsDir: "./agents",
  defaults: { resources: { cpu: "1000m", memory: "1Gi" } },
});

describe("loadAgent and the configured provider", () => {
  it("refuses an unknown provider before it touches a sandbox", async () => {
    // The adapter is never used: the client is built, and refused, first.
    // eslint-disable-next-line strict-ts/no-chained-type-assertions -- deliberately empty
    const adapter = {} as unknown as IStorageAdapter;

    // bun-types types `.rejects` as returning void, so the await looks pointless to the linter.
    // eslint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression
    await expect(
      loadAgent(
        { name: "a", harness: "pi", model: "some-model" },
        { adapter, config: config("nope") },
      ),
    ).rejects.toThrow(/Unknown sandbox provider "nope"\. Known providers: opensandbox\./);
  });
});
