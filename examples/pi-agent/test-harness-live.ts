/**
 * Live check of the harness interface against a real Pi agent.
 *
 * The unit and contract suites run `PiAdapter` against a scripted bridge. This runs the same
 * guarantees against a real Pi in a real sandbox: one terminal event, steer refused when idle,
 * abort ending a turn, a rejected permission not running the tool, `agent.harness("pi")`.
 *
 * Run:  bun examples/pi-agent/test-harness-live.ts
 * Needs: OpenSandbox running and NVIDIA_API_KEY in the environment.
 * Prints one PASS or FAIL line per case. Exits 1 if any case fails.
 */
import { Alineo, type AgentEvent, type HarnessEvent } from "alineo";
import { SQLiteAdapter } from "@alineo-labs/sqlite";

const spec = (await Bun.file("./agents/hello-agent.json").json()) as Record<string, unknown>;
const results: Array<{ name: string; ok: boolean; note: string }> = [];

async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  const t0 = Date.now();
  try {
    const note = (await fn()) ?? "";
    results.push({ name, ok: true, note: `${note} (${Math.round((Date.now() - t0) / 1000)}s)` });
  } catch (e) {
    results.push({ name, ok: false, note: e instanceof Error ? e.message : String(e) });
  }
  const r = results.at(-1)!;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.note}`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const ledger = new SQLiteAdapter("./.alineo/ledger-harness-live.db");
const agent = await Alineo.start({ ...spec, name: `harness-live-${Date.now()}` } as never, {
  adapter: ledger,
});
console.log(`sandbox ${agent.sandboxId}\n`);

try {
  await check("adapter is the pi harness, harness('pi') is the same object", async () => {
    assert(agent.adapter.id === "pi", `id was ${agent.adapter.id}`);
    assert(agent.harness("pi") === agent.adapter, "harness('pi') is not agent.adapter");
    let threw = false;
    try {
      agent.harness("claude" as never);
    } catch {
      threw = true;
    }
    assert(threw, "harness('claude') did not throw");
  });

  await check("a plain turn ends with exactly one agent_end, last", async () => {
    const evs = await drain(agent.prompt("Reply with exactly the word: pong"));
    const ends = evs.filter((e) => e.type === "agent_end");
    assert(ends.length === 1, `agent_end count was ${ends.length}`);
    assert(evs.at(-1)?.type === "agent_end", `last event was ${evs.at(-1)?.type}`);
    const text = evs.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
    assert(/pong/i.test(text), `reply was ${JSON.stringify(text.slice(0, 80))}`);
    return `${evs.length} events`;
  });

  await check("runTurn yields harness events, one done, last", async () => {
    const evs: HarnessEvent[] = [];
    for await (const e of agent.adapter.runTurn({ message: "Reply with exactly the word: ok" })) {
      evs.push(e);
    }
    const dones = evs.filter((e) => e.type === "done");
    assert(dones.length === 1, `done count was ${dones.length}`);
    assert(evs.at(-1)?.type === "done", `last was ${evs.at(-1)?.type}`);
    assert(
      evs.at(-1)?.type === "done" && (evs.at(-1) as { reason: string }).reason === "completed",
      "not completed",
    );
    const withRaw = evs.filter((e) => e.raw !== undefined).length;
    return `${evs.length} events, ${withRaw} carry raw`;
  });

  await check("steer with no turn running is refused", async () => {
    let msg = "";
    try {
      await agent.steer("go left");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(/no turn in progress/.test(msg), `message was ${JSON.stringify(msg)}`);
    return msg;
  });

  await check("steer while a turn runs is accepted; abort ends the turn", async () => {
    const stream = agent.prompt(
      "Use the bash tool to run: sleep 40; echo finished. Then reply with the word done.",
    );
    const events: AgentEvent[] = [];
    let steered = false;
    let aborted = false;
    const deadline = Date.now() + 150_000;
    for await (const ev of stream) {
      events.push(ev);
      if (!steered && (ev.type === "tool_start" || ev.type === "message_update")) {
        steered = true;
        await agent.steer("Also say hello when you are done.");
      }
      if (steered && !aborted && ev.type === "tool_start") {
        aborted = true;
        await agent.abort();
      }
      if (Date.now() > deadline) throw new Error("the turn did not end after abort");
    }
    assert(steered, "the turn produced no event to steer on");
    assert(aborted, "never saw a tool_start to abort on");
    assert(!events.some((e) => e.type === "agent_end"), "an aborted turn still produced agent_end");
    return `${events.length} events`;
  });

  await check("deprecated getCommands still works and matches harness('pi')", async () => {
    const viaAgent = await agent.getCommands();
    const viaHarness = await agent.harness("pi").getCommands();
    assert(Array.isArray(viaAgent), "getCommands did not return an array");
    assert(viaAgent.length === viaHarness.length, "the two paths disagree");
    return `${viaAgent.length} commands`;
  });
} finally {
  await agent.close().catch(() => {});
}

// A second agent with a permission policy, to see a real gate raise and block.
const gated = await Alineo.start(
  { ...spec, name: `harness-live-gate-${Date.now()}`, permissions: "ask" } as never,
  { adapter: ledger },
);
try {
  await check("a rejected permission does not run the tool, an allowed one does", async () => {
    const rejected = await drain(
      gated.prompt("Use the bash tool to run: echo gate-test-reject. Then say done.", {
        onPermission: () => ({ kind: "reject", feedback: "not allowed in this test" }),
      }),
    );
    assert(
      rejected.some((e) => e.type === "permission_request"),
      "no permission_request was raised",
    );
    assert(
      !rejected.some((e) => e.type === "tool_end" && e.toolName === "bash" && !e.isError),
      "bash ran successfully after a reject",
    );
    const allowed = await drain(
      gated.prompt("Use the bash tool to run: echo gate-test-allow. Then say done.", {
        onPermission: () => ({ kind: "once" }),
      }),
    );
    assert(
      allowed.some((e) => e.type === "tool_end" && e.toolName === "bash" && !e.isError),
      "bash did not run after an allow",
    );
    return "reject blocked, allow ran";
  });
} finally {
  await gated.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
