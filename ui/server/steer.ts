import { db } from "./db";
import { getSandbox, listSandboxes } from "./sandboxes";
import { peekAgent, getAgent } from "./runtime";
import { resolveModel, scrub } from "./models";
import { promptAgent, recordEvent } from "./agents";
import { log as slog } from "./log";

/**
 * How a message reaches the agent:
 *  - steer:    redirect the turn that is running right now
 *  - followUp: queue the message for when the current turn ends. An idle agent starts a turn with it
 *  - abort:    stop the current turn
 */
export type SteerMode = "steer" | "followUp" | "abort";

export interface SteerResult {
  sandboxId: string;
  delivered: boolean;
  /** Why it was not delivered. Absent when delivered. */
  reason?: string;
}

export async function steerAgent(
  userId: string,
  sandboxId: string,
  directive: string,
  scope: "node" | "subtree" | "fleet" = "node",
  mode: SteerMode = "steer",
): Promise<{ results: SteerResult[]; affectedSandboxIds: string[]; directive: string; scope: string; mode: SteerMode }> {
  const sb = getSandbox(userId, sandboxId);
  if (!sb) throw new Error(`Sandbox ${sandboxId} not found`);
  if (mode !== "abort" && !directive.trim()) throw new Error("Missing directive");

  const all = listSandboxes(userId);
  const affected: string[] = [sb.id];
  if (scope === "subtree") {
    const walk = (parentId: string) => {
      for (const child of all.filter((s) => s.parentId === parentId)) {
        if (!affected.includes(child.id)) { affected.push(child.id); walk(child.id); }
      }
    };
    walk(sb.id);
  } else if (scope === "fleet") {
    for (const s of all) if (!affected.includes(s.id)) affected.push(s.id);
  }

  const now = Date.now();
  const stamp = new Date(now).toISOString().substring(11, 23);
  const results: SteerResult[] = [];

  for (const id of affected) {
    const target = all.find((s) => s.id === id)!;
    const model = resolveModel(target.modelProvider);
    if (!target.agent) {
      results.push({ sandboxId: id, delivered: false, reason: "no agent in this sandbox" });
    } else if (target.status !== "running") {
      results.push({ sandboxId: id, delivered: false, reason: `sandbox is ${target.status}` });
    } else {
      try {
        const { agent } = await getAgent(id, model.id, target.cpuLimitMilli, target.memLimitMi);
        // Busy means a prompt stream is open, or Pi is still working on earlier input.
        const state = await agent.getState().catch(() => null);
        const busy = (peekAgent(id)?.busy ?? false) || Boolean(state?.isStreaming);
        if (mode === "abort") await agent.abort();
        else if (mode === "followUp") {
          if (busy) await agent.followUp(directive);
          // Pi queues a follow-up behind a running turn. An idle agent would never act on it, so start a turn.
          else void (async () => { for await (const _frame of promptAgent(userId, id, directive)) { /* logged by promptAgent */ } })();
        } else if (!busy) {
          // Steering needs a turn in progress. Say so instead of dropping the message.
          results.push({ sandboxId: id, delivered: false, reason: "the agent is idle: send it as a prompt or follow-up" });
          continue;
        } else {
          await agent.steer(directive);
          const live = peekAgent(id);
          if (live) live.steered = true;
        }
        results.push({ sandboxId: id, delivered: true });
      } catch (err) {
        results.push({ sandboxId: id, delivered: false, reason: scrub(err instanceof Error ? err.message : String(err), model) });
      }
    }
  }

  const verb = mode === "abort" ? "abort" : mode === "followUp" ? "follow-up" : "steer";
  const insertLog = db.prepare(`INSERT INTO sandbox_logs (user_id, sandbox_id, type, text, ts) VALUES (?, ?, ?, ?, ?)`);
  for (const r of results) {
    const text = r.sandboxId === sb.id
      ? `[${stamp}] ${verb} (scope=${scope}) ${mode === "abort" ? "" : `-> "${directive}"`} ${r.delivered ? "delivered" : `not delivered: ${r.reason}`}`
      : `[${stamp}] inherited ${verb} from ${sb.id} ${r.delivered ? "delivered" : `not delivered: ${r.reason}`}`;
    insertLog.run(userId, r.sandboxId, "steer", text, now);
  }

  recordEvent(userId, sb.id, "steer", JSON.stringify({
    label: mode === "abort" ? "Stopped" : mode === "followUp" ? "Queued" : "Steered",
    text: mode === "abort" ? "" : directive,
    results,
  }));

  const delivered = results.filter((r) => r.delivered).length;
  slog("info", "steer", { user: userId, sandbox: sb.id, run: sb.runId ?? undefined, mode, scope, targets: results.length, delivered, notDelivered: results.filter((r) => !r.delivered).map((r) => ({ sandbox: r.sandboxId.slice(0, 8), reason: r.reason })) }, true);
  db.prepare(`
    INSERT INTO ledger (user_id, ts, type, sandbox_id, tool, detail, branch, short_label, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, now, "exec_event", sb.id, "AGENT_STEER",
    `${verb} ${sb.id} (scope=${scope}, delivered=${delivered}/${results.length})${mode === "abort" ? "" : `: "${directive}"`}`,
    sb.parentId ? "fork" : "main", verb,
    JSON.stringify({ target: sb.id, scope, mode, directive, results }),
  );

  return { results, affectedSandboxIds: affected, directive, scope, mode };
}
