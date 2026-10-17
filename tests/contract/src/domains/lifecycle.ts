import { describe, expect, test } from "bun:test";
import { SandboxStatus } from "@alineo-labs/core";
import { AlineoError, errorCodeOf } from "@alineo-labs/errors";
import type { ProviderBinding } from "../binding";
import { withSandbox } from "../helpers";

export function lifecycleDomain(binding: ProviderBinding): void {
  describe(`${binding.name}: lifecycle`, () => {
    test("a created sandbox answers a command, and a session is listed under its run", async () => {
      await withSandbox(binding, "lifecycle-run", async (sb, client) => {
        const { stdout } = await sb.exec("echo alive");
        expect(stdout.trim()).toBe("alive");

        const details = await client.sandboxes.list();
        expect(details.map((d) => d.sandboxId)).toContain(sb.sandboxId);
      });
    });

    test("close() releases the sandbox, and the ledger says it completed", async () => {
      const client = binding.createClient();
      const sb = await client.sandbox({
        image: binding.image,
        resources: binding.resources,
        name: "contract-lifecycle-close",
      });
      const id = sb.sandboxId;
      await sb.close();

      const details = (await client.sandboxes.list()).find((d) => d.sandboxId === id);
      expect(details?.status).toBe(SandboxStatus.Completed);
    });

    test("the ledger records which provider owns the sandbox", async () => {
      await withSandbox(binding, "lifecycle-provider", async (sb, client) => {
        const details = (await client.sandboxes.list()).find((d) => d.sandboxId === sb.sandboxId);
        expect(details?.sandboxId).toBe(sb.sandboxId);
        expect(typeof details?.provider).toBe("string");
        expect(details?.provider?.length).toBeGreaterThan(0);
      });
    });

    test("an image that cannot be pulled fails with an alineo error, and does not hang", async () => {
      const client = binding.createClient();
      const started = Date.now();
      const err = await client
        .sandbox({
          image: "registry.invalid/alineo/does-not-exist:0",
          resources: binding.resources,
          name: "contract-lifecycle-bad-image",
        })
        .then(
          (sb) => {
            void sb.close();
            return undefined;
          },
          (e: unknown) => e,
        );

      expect(err).toBeDefined();
      expect(err).toBeInstanceOf(Error);
      // A typed failure the caller can branch on, not a bare Error.
      expect(err instanceof AlineoError || errorCodeOf(err) !== undefined).toBe(true);
      // Bounded: not the 120 s default start timeout.
      expect(Date.now() - started).toBeLessThan(110_000);
    });
  });
}
