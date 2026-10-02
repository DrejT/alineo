/**
 * `notifyOn` and the per-agent inbox (research/swarm-coordination.md §3c, research/tier-1-2-plan.md
 * #5): an agent keeps working and is *told* when an agent it watches finishes, instead of blocking
 * on it the way `waitFor` does.
 *
 * - A subscription (`notify_registered`) says "tell <subscriber> when <agent> ends".
 * - Every way an agent can finish emits `agent_ended` (a turn, a caught-up turn, a stop, lost, a
 *   budget refusal), so that one event queues an inbox entry for each subscriber
 *   (`inbox_queued`). A re-prompted agent that finishes again notifies again, marked `again`.
 * - Delivery depends on the recipient right now, and merges everything pending into one message:
 *     running        → steer (lands after its current tool call, before its next model call)
 *     paused         → held; delivered right after resume
 *     idle           → held until its next prompt (prepended), or a new turn if the subscription
 *                      asked to `wake` it / an operator calls POST /agents/:id/inbox/deliver
 *     not forked yet → held until its first prompt
 *     closed         → dropped
 * - The inbox is a ledger projection, so pending entries survive a restart; rehydrate re-delivers.
 *
 * The same inbox carries `steer` entries: a subtree steer to a paused parent waits here (steer.ts).
 */
import { get } from "./registry";
import { emit, onEmit } from "./emit";
import { driveTurn, isTurnActive } from "./stream";
import { readResult } from "./results";
import { HttpError } from "./errors";
import {
  getAgentRow,
  getHandle,
  notifiedBefore,
  pendingInbox,
  subscribersOf,
  subscription,
  type InboxRow,
} from "../state/projection";

const CLOSED_STATES = new Set(["aborted", "lost"]);
const EXCERPT_CHARS = 300;

export type Delivery = "steer" | "turn" | "held" | "dropped" | "none";

/** Subscribe `subscriberId` to every agent in `onIds`. Agents that already ended notify at once. */
export function registerNotify(
  runId: string,
  subscriberId: string,
  onIds: string[],
  wake = false,
): void {
  for (const id of onIds) {
    const row = getAgentRow(id);
    if (!row || row.run_id !== runId)
      throw new HttpError(400, `unknown agent ${id} in run ${runId}`);
    if (id === subscriberId) throw new HttpError(400, "an agent can't subscribe to itself");
  }
  emit(runId, subscriberId, "notify.registered", { on: onIds, wake });
  for (const id of onIds) {
    const row = getAgentRow(id);
    if (row?.ended_at != null) queueNotification(subscriberId, id, row.outcome);
  }
}

/** Queue a notification that `aboutId` finished, then try to deliver it. */
function queueNotification(subscriberId: string, aboutId: string, outcome: string | null): void {
  const sub = getAgentRow(subscriberId);
  const about = getAgentRow(aboutId);
  if (!sub || !about) return;
  const text = readResult(aboutId);
  emit(sub.run_id, subscriberId, "inbox.queued", {
    kind: "notification",
    aboutAgentId: aboutId,
    aboutSpec: about.spec_name,
    outcome,
    resultRef: getHandle(aboutId)?.result_ref ?? null,
    excerpt: text ? text.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS) : null,
    again: notifiedBefore(subscriberId, aboutId),
  });
  void deliverPending(subscriberId);
}

/** Queue a steer message (a subtree steer to a paused parent), delivered like a notification. */
export function queueSteer(agentId: string, text: string): void {
  const row = getAgentRow(agentId);
  if (!row) return;
  emit(row.run_id, agentId, "inbox.queued", { kind: "steer", text });
}

/**
 * Tell a parent its child needs a supervision decision (agent-supervision.md) — automatic, NOT
 * opt-in like `notifyOn`/`registerNotify`: this is a safety-net relationship inherent to the
 * spawn tree itself, not a general pub/sub feature. Delivered through the same inbox mechanism
 * as any other notification (steers in if running, holds if paused, prepends to the next prompt
 * if idle) — the `agent.supervision_needed` ledger event is the real source of truth regardless
 * of whether the parent is even live to receive this.
 */
function queueSupervisionNotice(
  parentId: string,
  childId: string,
  reason: string,
  error: string,
): void {
  const row = getAgentRow(parentId);
  if (!row) return;
  emit(row.run_id, parentId, "inbox.queued", {
    kind: "supervision",
    aboutAgentId: childId,
    outcome: reason,
    excerpt: error.length > EXCERPT_CHARS ? `${error.slice(0, EXCERPT_CHARS)}…` : error,
  });
  void deliverPending(parentId);
}

onEmit((_runId, agentId, event, payload) => {
  if (event !== "agent.ended" || !agentId) return;
  for (const sub of subscribersOf(agentId)) {
    queueNotification(sub.subscriber_id, agentId, (payload.outcome as string | undefined) ?? null);
  }
});

// Supervision lives in supervision.ts, which only emits the event. Listening here, rather than
// importing this module from there, keeps the engine imports acyclic.
onEmit((_runId, agentId, event, payload) => {
  if (event !== "agent.supervision_needed" || !agentId) return;
  const parentId = getAgentRow(agentId)?.parent_agent_id;
  if (!parentId) return;
  queueSupervisionNotice(parentId, agentId, payload.reason as string, payload.error as string);
});

/** One message for everything pending — notifications first, then supervision, then any queued steer text. */
function composeInbox(items: InboxRow[]): string {
  const notes = items.filter((i) => i.kind === "notification");
  const supervision = items.filter((i) => i.kind === "supervision");
  const steers = items.filter((i) => i.kind === "steer");
  const parts: string[] = [];
  if (notes.length > 0) {
    const lines = notes.map((n) => {
      const who = `${n.about_agent_id} (${n.about_spec ?? "agent"})`;
      const verb = n.again ? "finished again" : "finished";
      const ref = n.result_ref ? ` Result: ${n.result_ref}` : "";
      const excerpt = n.excerpt
        ? ` — "${n.excerpt}${n.excerpt.length >= EXCERPT_CHARS ? "…" : ""}"`
        : "";
      return `- ${who} ${verb}: ${n.outcome ?? "unknown"}.${ref}${excerpt}`;
    });
    parts.push(`[alineo] Update from agents you're watching:\n${lines.join("\n")}`);
  }
  if (supervision.length > 0) {
    const lines = supervision.map(
      (s) => `- ${s.about_agent_id} is blocked (${s.outcome}): ${s.excerpt ?? ""}`,
    );
    parts.push(
      `[alineo] Sub-agents waiting on your decision — alineo prompt <id> "<guidance>" to retry, ` +
        `alineo stop <id> to give up:\n${lines.join("\n")}`,
    );
  }
  for (const s of steers) if (s.text) parts.push(s.text);
  return parts.join("\n\n");
}

/** Deliveries to one agent run one at a time, so nothing is delivered twice. */
const deliveryChains = new Map<string, Promise<unknown>>();

export function deliverPending(agentId: string, opts: { wake?: boolean } = {}): Promise<Delivery> {
  const prior = deliveryChains.get(agentId) ?? Promise.resolve();
  const next = prior.then(
    () => deliverNow(agentId, opts),
    () => deliverNow(agentId, opts),
  );
  const tail = next.catch(() => {});
  deliveryChains.set(agentId, tail);
  void tail.finally(() => {
    if (deliveryChains.get(agentId) === tail) deliveryChains.delete(agentId);
  });
  return next;
}

async function deliverNow(agentId: string, opts: { wake?: boolean }): Promise<Delivery> {
  const row = getAgentRow(agentId);
  if (!row) return "none";
  const pending = pendingInbox(agentId);
  if (pending.length === 0) return "none";
  const seqs = pending.map((p) => p.seq);
  const agent = get(agentId);

  if (CLOSED_STATES.has(row.state) || (row.ended_at !== null && !agent)) {
    emit(row.run_id, agentId, "inbox.dropped", { seqs, reason: "recipient-closed" });
    return "dropped";
  }
  if (!agent || !row.sandbox_id || row.state === "paused") return "held";

  const text = composeInbox(pending);
  if (row.state === "running" || isTurnActive(agentId)) {
    try {
      await agent.steer(text);
    } catch {
      return "held"; // retried at the next delivery point
    }
    emit(row.run_id, agentId, "inbox.delivered", { seqs, as: "steer" });
    return "steer";
  }

  // Idle (finished but open, or provisioned with no prompt yet).
  const wake =
    opts.wake === true ||
    pending.some(
      (p) =>
        p.kind === "steer" ||
        (p.about_agent_id !== null && subscription(agentId, p.about_agent_id)?.wake === 1),
    );
  if (!wake) return "held";
  emit(row.run_id, agentId, "inbox.delivered", { seqs, as: "turn" });
  void driveTurn(agentId, text);
  return "turn";
}

/**
 * For a prompt about to start on `agentId`: take everything pending and return the prompt with it
 * prepended (marking it delivered), so a notification that arrived while the agent was idle
 * reaches it with its next turn.
 */
export function withInbox(agentId: string, prompt: string): string {
  const row = getAgentRow(agentId);
  const pending = pendingInbox(agentId);
  if (!row || pending.length === 0) return prompt;
  emit(row.run_id, agentId, "inbox.delivered", { seqs: pending.map((p) => p.seq), as: "prompt" });
  return `${composeInbox(pending)}\n\n${prompt}`;
}
