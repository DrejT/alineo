import type { ExtensionAPI, ExtensionContext, ExecResult } from "@earendil-works/pi-coding-agent";

/**
 * DEPRECATED — see the "extensionsDeprecationNotice" field in this package's package.json.
 * Kept in place for backward compatibility (the before_agent_start guidance injection and
 * ensureAlineoReady() bootstrap below still work) — no removal planned yet.
 *
 * Used to also register alineo_spawn/alineo_prompt/alineo_agents/alineo_kill as typed tool calls,
 * wrapping the CLI's session-lifecycle primitives so a Pi agent didn't have to hand-roll shell
 * commands for them. Removed (see issue #21 Bug B): `alineo fork` — the core RLM fan-out
 * primitive — was deliberately never wrapped as a typed tool, on the reasoning that forking is
 * a judgment call about how to decompose a task and belongs in a real shell command the model
 * writes itself, not a verbal decision to call a fixed-shape registered tool. That left spawn/
 * prompt/agents/kill as typed tools sitting right next to fork's bash-only form — an asymmetry
 * that measurably steered models toward the wrong primitive in practice (a real run picked the
 * typed `alineo_spawn` tool over the `alineo fork` shell command the guidance text recommended for
 * that exact scenario). All five subcommands are bash-only now, with no asymmetry to lean on.
 *
 * Install on a host machine (recommended — makes this available in every Pi
 * session afterward, not just one project):
 *   pi install npm:alineo-cli
 *
 * `packages/cli/package.json`'s `"pi": { "extensions": [...] }` field is what
 * makes that resolve to this file (see `resolveExtensionEntries()` in Pi's
 * own `package-manager.js`).
 *
 * Install into a single sandbox via a spec's setup steps instead (what
 * `examples/rlm-repo-fanout` does today, project-scoped):
 *   npm install -g alineo-cli
 *   mkdir -p .pi/extensions && cp "$(npm root -g)/alineo-cli/pi-extension/alineo.ts" .pi/extensions/alineo.ts
 */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await ensureAlineoReady(pi, ctx);
  });

  // `ALINEO_SANDBOX_ID` is only set inside a sandbox created by an agent-creation
  // path (Agent.load()/resume()/spawn(), see packages/agent/src/agent.ts) — its
  // presence here means THIS Pi process is itself running inside one, so it has
  // live state (installed packages, a checked-out repo, files on disk) worth
  // forking into children via `alineo fork`. A host-level session (a user's own
  // local Pi, no sandbox of its own) has nothing to fork — only `alineo spawn`
  // (start a fresh, independent agent) makes sense there.
  const canFork = Boolean(process.env.ALINEO_SANDBOX_ID);

  // Mechanical CLI guidance (above) is safe to inject unconditionally — it's
  // just "here's the syntax," true for any session. The RLM *mindset* prompt
  // below is opt-in: a one-off coding session shouldn't be told "you are an
  // orchestrator" unconditionally, only a spec deliberately built to act as
  // one. Gated on ALINEO_RLM_MASTER (set in that spec's own `env`), with
  // ALINEO_RLM_SYSTEM_PROMPT as a full override for specs that want their own
  // wording instead of the default — same ${VAR}-interpolation pattern every
  // other agent-spec env value already uses (see
  // examples/rlm-repo-fanout/agents/master.json's RLM_FANOUT_SECRET/
  // MASTER_AGENT_OPENSANDBOX_DOMAIN for the existing precedent).
  const rlmMindset = process.env.ALINEO_RLM_SYSTEM_PROMPT
    ? `\n\n${process.env.ALINEO_RLM_SYSTEM_PROMPT}`
    : process.env.ALINEO_RLM_MASTER
      ? DEFAULT_RLM_MINDSET
      : "";

  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + (canFork ? FORK_GUIDANCE : SPAWN_ONLY_GUIDANCE) + rlmMindset,
  }));
}

const FORK_GUIDANCE = `

## Orchestrating sub-agents with alineo

You have the \`alineo\` CLI available. Your own session is running inside a
alineo-managed sandbox, so you can fork YOUR OWN live filesystem state
(installed packages, a checked-out repo, any files already on disk) into
independent child agents:

    alineo fork <your-session-name> <child-spec.json> --prompt "<plain-English instruction>" --json

Each forked child starts from your exact current state, not a fresh clone —
use this when children need to see something you've already set up. Run this
as an actual shell command via your bash tool, not by describing it — you
decide how many children to fork and how to split the work; nothing scripts
that decision for you. Add \`--depth N\` / \`--max N\` to override a spec's own
nesting-depth or total-descendant budget if it has one.

To start a completely independent agent instead (no shared state needed):
\`alineo spawn <spec.json> --prompt "<msg>" --json\`. Other commands:
\`alineo agents [--json]\` (list running sessions), \`alineo prompt <sandbox-id>
<msg>\` (continue talking to one), \`alineo kill <sandbox-id>\` (stop one).

Only reach for forking when a task genuinely splits into independent pieces
of real size — for something you can finish yourself in a few tool calls,
just do it directly.`;

const SPAWN_ONLY_GUIDANCE = `

## Starting sub-agents with alineo

You have the \`alineo\` CLI available to start independent agent sessions in
their own sandboxes:

    alineo spawn <spec.json> --prompt "<msg>" --json

Other commands: \`alineo agents [--json]\` (list running sessions), \`alineo
prompt <sandbox-id> <msg>\` (continue talking to one), \`alineo kill
<sandbox-id>\` (stop one). A spawned agent running inside its own sandbox may
itself be able to fork further sub-agents from its own live state via
\`alineo fork\` — that's its own decision to make, not yours to script for it.`;

const DEFAULT_RLM_MINDSET = `

## Your role: RLM orchestrator

Think in terms of decompose, delegate, and collect. When a task is large
enough to genuinely split into independent pieces, prefer forking dedicated
sub-agents over doing everything yourself in one long session — each
sub-agent should get a clear, bounded slice of the work and report back a
concise result, not its full transcript. Keep your own context focused on
decomposition and integration, not on redoing what a child already did. For
small or genuinely atomic tasks, just do the work yourself — decomposition
should reflect the task's real shape, not be forced on something that
doesn't need it.`;

// Runs once per extension load, not once per `session_start` — that event
// also fires on reload/new/resume/fork, and `alineo init` (while itself
// idempotent) has a few seconds of Docker-state-check overhead not worth
// repeating every time. Reset on failure so a later session_start can retry
// instead of a transient failure (no network, Docker not running yet)
// permanently wedging bootstrap for the rest of the process.
let bootstrapped = false;

async function execOk(
  pi: ExtensionAPI,
  command: string,
  args: string[],
): Promise<ExecResult | null> {
  try {
    return await pi.exec(command, args);
  } catch {
    return null;
  }
}

/**
 * Ensures `alineo` is installed and OpenSandbox is reachable, so the user
 * never has to run either setup step themselves — this extension is meant
 * to be the entire distribution/setup path. `alineo init` already no-ops
 * cleanly when OpenSandbox is already running (see `packages/cli/src/commands/init.ts`),
 * so it's safe to call unconditionally rather than trying to detect
 * reachability here first.
 */
async function ensureAlineoReady(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;

  const check = await execOk(pi, "alineo", ["--version"]);
  if (!check || check.code !== 0) {
    ctx.ui.notify("Installing alineo...", "info");
    const install = await execOk(pi, "npm", ["install", "-g", "alineo-cli"]);
    if (!install || install.code !== 0) {
      ctx.ui.notify(
        `Failed to install alineo: ${install?.stderr || "npm not available"}. ` +
          `RLM flows won't work until this is resolved — install manually with "npm install -g alineo-cli".`,
        "error",
      );
      bootstrapped = false;
      return;
    }
  }

  const init = await execOk(pi, "alineo", ["init"]);
  if (!init || init.code !== 0) {
    ctx.ui.notify(
      `"alineo init" failed: ${init?.stderr || "unknown error"}. ` +
        `RLM flows won't work until OpenSandbox is reachable — see "alineo init" for manual setup.`,
      "warning",
    );
    bootstrapped = false;
  }
}
