/**
 * `POST /agents/:agentId/steer` — inject a message into a currently-running turn, redirecting
 * it without waiting for the turn to finish (unlike `/prompt`'s queued follow-up). A thin
 * wrapper over `Alineo.steer()` — a fire-and-forget ack to the bridge's `/steer` endpoint;
 * Pi's own RPC layer owns what "redirect" actually means turn-to-turn, not alineod — plus a
 * ledger event so it shows up in the audit trail and the SSE stream.
 *
 * Scope: steer never broadcasts (research/swarm-control.md §8a) — the same words rarely fit a
 * parent and its workers. `steerSubtree` is the subtree form (research/tier-1-2-plan.md #6): it
 * delivers ONE message to the parent — the operator's text plus a roster of its direct children —
 * and the parent re-plans and redirects each child itself, with the CLI it already has.
 */
import { get } from "./registry";
import { getAgentRow, resolveSubtree } from "../state/projection";
import { emit } from "./emit";
import { HttpError } from "./errors";
import { driveTurn, isTurnActive } from "./stream";
import { queueSteer, withInbox } from "./notify";

export async function steerAgent(agentId: string, message: string): Promise<void> {
  const row = getAgentRow(agentId);
  if (!row) throw new HttpError(404, `no agent ${agentId}`);

  const agent = get(agentId);
  if (!agent) throw new HttpError(409, `agent ${agentId} is not live (cannot steer it)`);

  try {
    await agent.steer(message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(502, `steer failed: ${msg}`);
  }

  emit(row.run_id, agentId, "agent_steered", { message });
}

export interface RosterEntry {
  agentId: string;
  sandboxId: string | null;
  specName: string;
  state: string;
  outcome: string | null;
}

export interface SubtreeSteerResult {
  deliveredAs: "steer" | "turn" | "queued";
  roster: RosterEntry[];
}

const PROMPT_EXCERPT = 200;

/**
 * Steer a parent about its whole subtree. The parent gets one message — the operator's text, its
 * direct children, and instructions to re-plan — delivered by its state:
 *
 *   running → steer (lands after its current tool call)
 *   idle    → a new turn (its handle settles again when that turn ends)
 *   paused  → queued in its inbox, delivered on resume
 *
 * Children see nothing directly. The parent acts on them with the CLI it already has, which talks
 * to OpenSandbox directly (option (a) in the plan): those actions aren't in alineod's ledger, and
 * children it forks itself aren't part of alineod's tree.
 */
export async function steerSubtree(parentId: string, message: string): Promise<SubtreeSteerResult> {
  const row = getAgentRow(parentId);
  if (!row) throw new HttpError(404, `no agent ${parentId}`);
  const agent = get(parentId);
  if (!agent) throw new HttpError(409, `agent ${parentId} is not live (cannot steer it)`);

  const children = resolveSubtree(parentId).filter((m) => m.parent_agent_id === parentId);
  const roster: RosterEntry[] = children.map((c) => ({
    agentId: c.agent_id,
    sandboxId: c.sandbox_id,
    specName: c.spec_name,
    state: c.state,
    outcome: c.outcome,
  }));
  const envelope = composeEnvelope(message, children);

  let deliveredAs: SubtreeSteerResult["deliveredAs"];
  if (row.state === "paused") {
    queueSteer(parentId, envelope);
    deliveredAs = "queued";
  } else if (row.state === "running" || isTurnActive(parentId)) {
    try {
      await agent.steer(envelope);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpError(502, `steer failed: ${msg}`);
    }
    deliveredAs = "steer";
  } else {
    void driveTurn(parentId, withInbox(parentId, envelope));
    deliveredAs = "turn";
  }

  emit(row.run_id, parentId, "agent_steered", {
    message,
    scope: "subtree",
    roster: roster.map((r) => r.agentId),
    deliveredAs,
  });
  return { deliveredAs, roster };
}

function composeEnvelope(
  message: string,
  children: {
    agent_id: string;
    sandbox_id: string | null;
    spec_name: string;
    state: string;
    outcome: string | null;
    prompt: string | null;
  }[],
): string {
  const rows = children.map((c) => {
    const prompt = (c.prompt ?? "").replace(/\s+/g, " ").trim();
    const excerpt = prompt.length > PROMPT_EXCERPT ? `${prompt.slice(0, PROMPT_EXCERPT)}…` : prompt;
    return `| ${c.agent_id} | ${c.sandbox_id ?? "(not forked yet)"} | ${c.spec_name} | ${c.state} | ${c.outcome ?? "—"} | ${excerpt || "—"} |`;
  });
  const roster =
    rows.length > 0
      ? [
          "You delegated work to these sub-agents:",
          "",
          "| agentId | sandboxId | spec | state | outcome | what you asked it to do |",
          "|---|---|---|---|---|---|",
          ...rows,
        ].join("\n")
      : "You have no sub-agents yet.";
  return [
    "## Operator steer for you and your sub-agents",
    "",
    message,
    "",
    roster,
    "",
    "Re-plan against this: update your task list, then decide for EACH sub-agent whether to redirect it,",
    "stop it, or leave it — and whether the new direction needs new sub-agents. Write each child a",
    "message for ITS task, not a copy of this one. Use:",
    '  alineo steer <sandboxId> "<message for that child>"',
    "  alineo kill <sandboxId>",
    '  alineo fork self <child-spec.json> --prompt "<task>"',
  ].join("\n");
}
