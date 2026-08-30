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
import { Alineo } from "alineo";
import type { AgentStream } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

function section(label: string) {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 58 - label.length))}\n`);
}

/**
 * Run one agent turn, narrating the full event stream — not just `textOnly()`. The point of
 * this recipe is watching the agent issue its *own* authenticated requests, so we echo each
 * `bash` command it runs and the output that came back. The tool activity is the evidence
 * that matters here, whether or not the model bothers with a prose summary afterward.
 */
async function runAgentTurn(stream: AgentStream) {
  for await (const ev of stream) {
    if (ev.type === "text") {
      process.stdout.write(ev.text);
    } else if (ev.type === "tool_start" && ev.toolName === "bash") {
      const cmd = (ev.args as { command?: string }).command ?? "";
      process.stdout.write(`\n  $ ${cmd}\n`);
    } else if (ev.type === "tool_end") {
      const out = (ev.result as { content?: { text?: string }[] }).content?.[0]?.text?.trim();
      process.stdout.write(
        out ? `${out.replace(/^/gm, "  ")}\n` : `  ${ev.isError ? "(failed)" : "(ok)"}\n`,
      );
    }
  }
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

  // A directive prompt, not an open-ended one: the recipe is about the credential mechanism,
  // not the model's planning. The agent runs the curl itself — no token, no Authorization
  // header of its own — and it comes back authenticated as you.
  await runAgentTurn(
    agent.prompt(
      "Run this command and report the value it prints. It's already authenticated — you " +
        "don't need a token or an Authorization header:\n" +
        "  curl -sS https://api.github.com/user | jq -r .login",
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
  console.log("\nThe agent's own next call to api.github.com would fail the same way.");
} finally {
  await agent.close();
  console.log("\nAgent closed.");
}
