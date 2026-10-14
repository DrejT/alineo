import { describe, expect, test } from "bun:test";
import type { ProviderBinding } from "../binding";
import { withSandbox } from "../helpers";

/**
 * Paths spread across the filesystem on purpose. A snapshot that keeps the workspace but drops
 * something under `/etc` or `/usr/local` looks fine in a demo and breaks an installed agent.
 * This is the failure behind OpenSandbox#1831 (gVisor `docker commit` kept 0 of 9 writes).
 */
const PATHS = [
  "/workspace/contract-a.txt",
  "/root/contract-b.txt",
  "/opt/contract-c.txt",
  "/usr/local/bin/contract-tool",
  "/etc/contract-d.conf",
  "/var/lib/contract-e.dat",
  "/home/contract-f.txt",
  "/srv/contract-g.txt",
  "/tmp/contract-h.txt",
];

export function snapshotDomain(binding: ProviderBinding): void {
  describe(`${binding.name}: snapshot`, () => {
    test("a fork keeps every file written before the checkpoint", async () => {
      await withSandbox(binding, "snapshot-keeps", async (sb) => {
        for (const path of PATHS) {
          await sb.exec(`mkdir -p "$(dirname ${path})" && printf 'value-for-${path}' > ${path}`);
        }
        await sb.exec("chmod +x /usr/local/bin/contract-tool");

        const child = await sb.fork("contract-keeps");
        try {
          const missing: string[] = [];
          for (const path of PATHS) {
            const r = await child.exec(`cat ${path} 2>/dev/null || echo __MISSING__`, {
              strict: false,
            });
            if (r.stdout.trim() !== `value-for-${path}`) missing.push(path);
          }

          const known = new Set(binding.snapshotKnownLosses ?? []);
          const unexpected = missing.filter((p) => !known.has(p));
          expect(unexpected, `snapshot lost: ${unexpected.join(", ")}`).toEqual([]);

          // A known loss that is no longer lost means the list is stale. Say so.
          const recovered = [...known].filter((p) => !missing.includes(p));
          expect(recovered, `listed as lost but present: ${recovered.join(", ")}`).toEqual([]);
        } finally {
          await child.close().catch(() => {});
        }
      });
    });

    test("a fork is independent: a write in the child does not reach the parent", async () => {
      await withSandbox(binding, "snapshot-independent", async (sb) => {
        await sb.exec("printf 'parent' > /workspace/who.txt");
        const child = await sb.fork("contract-independent");
        try {
          await child.exec("printf 'child' > /workspace/who.txt");
          expect((await sb.readFile("/workspace/who.txt")).trim()).toBe("parent");
          expect((await child.readFile("/workspace/who.txt")).trim()).toBe("child");
        } finally {
          await child.close().catch(() => {});
        }
      });
    });

    test("checkpoint() returns an id, and the parent keeps running", async () => {
      await withSandbox(binding, "snapshot-parent", async (sb) => {
        const id = await sb.checkpoint("contract-parent");
        expect(id.length).toBeGreaterThan(0);
        const r = await sb.exec("echo still-here");
        expect(r.stdout.trim()).toBe("still-here");
      });
    });
  });
}
