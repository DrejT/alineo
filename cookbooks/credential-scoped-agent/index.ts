/**
 * Recipe: give an agent a capability, not a secret.
 *
 * A Pi agent is tasked with real work against the GitHub API — but the token that
 * authorizes it is registered as a *credential*, not an env var. It gets injected into
 * matching outbound requests at the egress layer, so the agent (which writes and runs its
 * own shell commands) can call `api.github.com` as you, yet can never read, log, or
 * exfiltrate the token itself. Revoking it mid-session takes effect immediately, without
 * touching the running sandbox.
 *
 * Needs a running OpenSandbox server (`alineo init`) plus two things in the environment:
 *
 *   NVIDIA_API_KEY  the agent's own model key (NVIDIA NIM, free tier at build.nvidia.com).
 *                   A plain env var — it's infrastructure the agent legitimately needs to
 *                   think, not a user credential.
 *   GH_TOKEN        a GitHub token (classic or fine-grained PAT). Read-only scopes are
 *                   plenty for this recipe. Just the token — the agent spec adds the
 *                   `Bearer` scheme. This value never enters the container's environment.
 */
import { Alineo, textOnly } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

function section(label: string) {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 58 - label.length))}\n`);
}

async function say(stream: AsyncIterable<string>) {
  for await (const chunk of stream) process.stdout.write(chunk);
  console.log();
}

if (!process.env.GH_TOKEN) {
  console.error("Set GH_TOKEN to a GitHub token first — see this recipe's README.");
  process.exit(1);
}

const adapter = new SQLiteAdapter("./.alineo/ledger.db");
const spec = await Bun.file("./agents/github-agent.json").json();

// `env.GITHUB_TOKEN` in the spec is a credential binding, not a string — so `Alineo.load()`
// creates the sandbox with `credentialProxy: true` and registers the token with the egress
// sidecar's Credential Vault instead of exporting it. `env.NVIDIA_API_KEY`, a plain string,
// goes into the container's environment the ordinary way.
const agent = await Alineo.load(spec, { adapter });

try {
  section("what the agent is allowed to reach");

  // Binding metadata only — host + injection shape. The vault never echoes the value back,
  // so there is nothing sensitive to print here even if we wanted to.
  console.log("bound credentials:", await agent.sandbox.credentials.listBindings());

  // ── 1. Delegate real work ───────────────────────────────────────────────────
  section("1. the agent does authenticated GitHub work");

  await say(
    textOnly(
      agent.prompt(
        "Use the GitHub API at api.github.com, with curl and jq, to find out which account " +
          "the ambient credentials belong to, then list that account's 3 most recently " +
          "pushed repositories. Don't look for a token or an Authorization header — just " +
          "make the requests, they're already authenticated. Keep your reply short.",
      ),
    ),
  );

  // ── 2. Audit what the agent could actually see ──────────────────────────────
  section("2. the token was never in the sandbox");

  // The agent just wrote and ran its own commands against an authenticated API. The token
  // still isn't anywhere in the container it could have found it.
  const leaked = await agent.sandbox.exec(
    "env | grep -iE 'token|auth|github' || echo '(nothing — as expected)'",
    { strict: false },
  );
  console.log("secrets in the environment:", leaked.stdout.trim());

  // A bare request with no Authorization header of its own — the sidecar adds it because the
  // host matches the binding. This is injection happening at the network layer, not anything
  // the agent (or this script) did to the request.
  const authed = await agent.sandbox.exec(
    'curl -sS -o /dev/null -w "%{http_code}" https://api.github.com/user',
    { strict: false },
  );
  console.log(`raw curl to api.github.com, no auth header:  HTTP ${authed.stdout.trim()}`);

  // ── 3. Revoke — mid-session, without touching the sandbox ───────────────────
  section("3. revoke, and the same request stops working");

  await agent.sandbox.credentials.remove("GITHUB_TOKEN");
  console.log("bound credentials now:", await agent.sandbox.credentials.listBindings());

  const afterRevoke = await agent.sandbox.exec(
    'curl -sS -o /dev/null -w "%{http_code}" https://api.github.com/user',
    { strict: false },
  );
  console.log(`same request, after revoke:                   HTTP ${afterRevoke.stdout.trim()}`);

  // And the agent notices it too, next time it tries.
  await say(
    textOnly(
      agent.prompt(
        "Try GET https://api.github.com/user again with curl and report just the HTTP " +
          "status code you get back now.",
      ),
    ),
  );
} finally {
  await agent.close();
  console.log("\nAgent closed.");
}
