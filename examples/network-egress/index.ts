/**
 * Network egress control — a deny-by-default sandbox whose allow-list is changed at runtime.
 *
 * Shows, in order:
 *   1. `networkPolicy: { defaultAction: "deny" }` — the sandbox can reach nothing.
 *   2. `sb.egress.patch()` — allow a host on the *running* sandbox; it becomes reachable.
 *   3. CIDR / IP targets are accepted too (nftables layer; needs `egress.mode = "dns+nft"`).
 *   4. `sb.egress.delete()` — revoke the host; it's blocked again.
 *   5. `sb.egress.get()` — read back the live policy.
 *
 * Every change is also recorded to the ledger (`EgressRuleAdded` / `EgressRuleRemoved`), so
 * `Sandbox.resume()` re-applies whatever is still live — egress policy is sidecar-local and
 * does not survive a resume on its own.
 *
 * Requires the OpenSandbox server to have `egress.image` configured with `egress.mode = "dns+nft"`
 * (the default for `alineo init`). Run: `cd examples/network-egress && bun install && bun start`.
 */
import { Sandbox, type SandboxHandle } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Sandbox({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

/** `getent hosts` exits 0 iff the name resolves — i.e. the egress policy let the DNS query through. */
async function canReach(sb: SandboxHandle, host: string): Promise<boolean> {
  const { exitCode } = await sb.exec(`getent hosts ${host}`, { strict: false });
  return exitCode === 0;
}

const report = async (sb: SandboxHandle, host: string) =>
  console.log(`  ${host.padEnd(20)} ${(await canReach(sb, host)) ? "reachable" : "blocked"}`);

const sb = await client.sandbox({
  image: "ubuntu:22.04",
  resources: { cpu: "500m", memory: "256Mi" },
  name: "network-egress",
  // Nothing is allowed out until we say so. (Omit `networkPolicy` entirely for the usual
  // unrestricted behaviour — no egress sidecar is attached at all.)
  networkPolicy: { defaultAction: "deny", egress: [] },
});
console.log(`sandbox ${sb.sandboxId}\n`);

try {
  console.log("1 · deny-by-default — nothing is reachable");
  await report(sb, "example.com");
  await report(sb, "example.org");

  console.log("\n2 · sb.egress.patch() — allow example.com on the running sandbox");
  await sb.egress.patch([{ action: "allow", target: "example.com" }]);
  await report(sb, "example.com");
  await report(sb, "example.org"); // still blocked

  console.log("\n3 · CIDR / IP targets are accepted too (enforced at the nftables layer —");
  console.log("    they gate raw-IP egress, not name resolution; use a domain rule for that)");
  await sb.egress.patch([{ action: "allow", target: "10.0.0.0/8" }]);

  console.log("\n4 · sb.egress.delete() — revoke example.com");
  await sb.egress.delete(["example.com"]);
  await report(sb, "example.com"); // blocked again

  console.log("\n5 · sb.egress.get() — the live policy");
  const status = await sb.egress.get();
  console.log(`   ${JSON.stringify(status.policy)}`);
} finally {
  await sb.close();
}
