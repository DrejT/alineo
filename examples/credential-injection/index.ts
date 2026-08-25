/**
 * Demonstrates credential injection: registering a credential with a sandbox so it gets
 * injected into matching outbound requests transparently, without the sandbox process ever
 * holding the real value.
 *
 * Requires the OpenSandbox server to have `egress.image` configured (the default for
 * `alineo init` since credential injection landed — see plans/credential-injection.md) and to
 * be running `egress.mode = "dns+nft"` for the Credential Vault to actually activate.
 */
import { Sandbox } from "@alineo-labs/sandbox";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const client = new Sandbox({
  baseUrl: process.env.OPEN_SANDBOX_URL ?? "http://127.0.0.1:8080",
  apiKey: process.env.OPEN_SANDBOX_API_KEY ?? "",
  adapter: new SQLiteAdapter("./ledger.db"),
  useServerProxy: process.env.USE_SERVER_PROXY !== "false",
});

// A real credential — never logged, never written to the ledger, never handed to the sandbox
// as a plain env var. Falls back to an obviously-fake value so this file is copy-paste-able
// without a real token on hand (the demo request will just 401, which is still instructive).
const githubToken = process.env.GH_TOKEN ?? "gh_demo_token_replace_me";

const sb = await client.sandbox({
  image: "ubuntu:22.04",
  resources: { cpu: "500m", memory: "512Mi" },
  name: "credential-injection",
  // `networkPolicy` + `credentialProxy: true` attach an egress sidecar to this sandbox —
  // omit both and it behaves exactly like every other example (unrestricted egress, no vault).
  networkPolicy: {
    defaultAction: "allow",
    egress: [],
  },
  credentialProxy: true,
});

console.log(`SandboxHandle ID: ${sb.sandboxId}`);

try {
  // ── Part 1: register + use a credential ───────────────────────────────────
  //
  // `source: { type: "env", varName: "GH_TOKEN" }` means resume()/fork() can re-resolve this
  // value automatically later from process.env — no callback needed. Omit `source` (or use
  // `{ type: "external" }`) for a value that isn't safely re-derivable the same way twice (a
  // one-time minted token, etc.) — resume()/fork() will require an explicit resolver for those.
  await sb.credentials.set(
    "github",
    githubToken,
    {
      host: "api.github.com",
      injection: { type: "header", name: "Authorization" },
    },
    { type: "env", varName: "GH_TOKEN" },
  );

  console.log("\n--- proving the sandbox never holds the real token ---");
  // No GH_TOKEN (or anything resembling it) in this sandbox's own environment — the credential
  // reached the request at the egress sidecar, not through a container env var.
  await sb.exec("env | grep -i github || echo '(nothing — as expected)'").pipe(process.stdout);

  console.log("\n--- request to the bound host, authenticated transparently ---");
  // This curl carries no Authorization header of its own — the sidecar adds it for requests
  // matching api.github.com. Expect a real 200 with a real token, a 401 with the demo fallback.
  await sb
    .exec('curl -s -o /dev/null -w "HTTP %{http_code}\\n" https://api.github.com/user')
    .pipe(process.stdout);

  // ── Part 2: fork() carries bound credentials to the child automatically ────
  console.log("\n--- forking: the child inherits the 'github' credential too ---");
  const child = await sb.fork("before-fork");
  try {
    await child
      .exec('curl -s -o /dev/null -w "HTTP %{http_code}\\n" https://api.github.com/user')
      .pipe(process.stdout);
  } finally {
    await child.close();
  }

  // ── Part 3: revoke ───────────────────────────────────────────────────────
  console.log("\n--- revoking, then repeating the same request ---");
  await sb.credentials.remove("github");
  await sb
    .exec('curl -s -o /dev/null -w "HTTP %{http_code}\\n" https://api.github.com/user')
    .pipe(process.stdout);
} finally {
  await sb.close();
}
