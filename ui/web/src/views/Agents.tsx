import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@ui-sdk/react/button";
import { Textarea } from "@ui-sdk/react/textarea";
import { ChevronRight, Globe, MessageSquare, OctagonX, SquareTerminal } from "lucide-react";
import { api, type Run, type RunNode, type Sandbox } from "../api";
import { Badge, Card, Empty, IconButton, PageHeader, act, cx, shortId, usePoll } from "../lib";
import { ConfirmDialog } from "./actions";
import { BrowserView } from "./BrowserView";
import { ChatPanel } from "./ChatPanel";
import { Pick } from "./Sandboxes";

const MODELS = [
  { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash (fast)" },
  { value: "gemini-3.8-pro", label: "Gemini 3.8 Pro (strongest)" },
  { value: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash Medium" },
];
const LIMITS = [2, 3, 4, 5, 6, 8].map((n) => ({ value: String(n), label: `${n} containers` }));

const GOAL_EXAMPLES = [
  "Compare three ways to compute fibonacci(32) in Python, with one agent per approach, and report which is fastest.",
  "Write a small Python CLI that converts CSV to JSON, have a second agent write tests for it, and run them.",
];

function elapsed(from: number, to: number | null): string {
  const sec = Math.max(0, Math.floor(((to ?? Date.now()) - from) / 1000));
  const m = Math.floor(sec / 60);
  return m === 0 ? `${sec}s` : `${m}m ${String(sec % 60).padStart(2, "0")}s`;
}

function runTone(status: Run["status"]) {
  return status === "done" ? "ok" : status === "failed" ? "bad" : status === "stopped" ? "neutral" : "info";
}
function nodeTone(n: RunNode) {
  return n.status === "terminated" ? "neutral" : n.state === "working" ? "info" : n.state === "done" ? "ok" : n.state === "failed" ? "bad" : "neutral";
}
function nodeLabel(n: RunNode) {
  return n.status === "terminated" ? "removed" : n.status === "paused" ? "paused" : n.state === "idle" ? "waiting" : n.state;
}

interface Tree { node: RunNode; kids: Tree[] }
function buildTree(nodes: RunNode[]): Tree[] {
  const byParent = new Map<string | null, RunNode[]>();
  for (const n of nodes) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n]);
  const ids = new Set(nodes.map((n) => n.id));
  const grow = (n: RunNode): Tree => ({ node: n, kids: (byParent.get(n.id) ?? []).map(grow) });
  // A node whose parent is not in the run is shown at the top, so nothing is hidden.
  return nodes.filter((n) => n.parentId === null || !ids.has(n.parentId)).map(grow);
}

function Chevron({ open, onClick, label, hidden }: { open: boolean; onClick: () => void; label: string; hidden?: boolean }) {
  if (hidden) return <span className="inline-block size-6" aria-hidden="true" />;
  return (
    <button type="button" onClick={onClick} aria-expanded={open} aria-label={label} className="inline-flex size-6 items-center justify-center rounded text-fd-muted-foreground hover:bg-fd-muted">
      <ChevronRight className={cx("size-4 transition-transform", open && "rotate-90")} aria-hidden="true" />
    </button>
  );
}

function NewGoal({ onStarted }: { onStarted: () => void }) {
  const [goal, setGoal] = useState("");
  const [model, setModel] = useState(MODELS[0]!.value);
  const [limit, setLimit] = useState("5");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!goal.trim() || busy) return;
    setBusy(true);
    const run = await act("Goal started", () => api.startRun({ goal: goal.trim(), modelProvider: model, maxAgents: Number(limit) }), onStarted);
    setBusy(false);
    if (run) setGoal("");
  }

  return (
    <Card className="p-5">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div>
          <h2 className="h-section">Start a goal</h2>
          <p className="mt-1 text-sm text-fd-muted-foreground">
            A master agent starts in its own container. It decides how to split the goal, creates more containers with their own agents, and reports back.
          </p>
        </div>
        <Textarea value={goal} onValueChange={setGoal} rows={3} aria-label="Goal" placeholder="Describe what the swarm should achieve…" />
        <div className="flex flex-wrap gap-1.5">
          {GOAL_EXAMPLES.map((g) => (
            <button key={g} type="button" onClick={() => setGoal(g)} className="rounded-pill border border-fd-border px-2.5 py-1 text-left text-xs text-fd-muted-foreground hover:bg-fd-muted">
              {g.length > 62 ? `${g.slice(0, 62)}…` : g}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56"><Pick label="Model" value={model} onChange={setModel} items={MODELS} /></div>
          <div className="w-44"><Pick label="Most containers" value={limit} onChange={setLimit} items={LIMITS} /></div>
          <Button type="submit" data-variant="solid" disabled={!goal.trim() || busy} className="ml-auto">{busy ? "Starting…" : "Start goal"}</Button>
        </div>
      </form>
    </Card>
  );
}

function Cell({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={cx("px-4 py-2.5 align-middle", className)}>{children}</td>;
}

/** One agent in a run, then its children. Defined at module scope so a poll does not remount it. */
function NodeRows({ tree, depth, open, toggle, list, onChat, onTerminal, onBrowser }: {
  tree: Tree; depth: number; open: Set<string>; toggle: (id: string) => void; list: Sandbox[];
  onChat: (id: string) => void; onTerminal: (id: string) => void; onBrowser: (id: string) => void;
}) {
  const n = tree.node;
  const live = list.find((s) => s.id === n.id);
  const isOpen = open.has(n.id);
  const canAct = Boolean(live) && live!.status === "running";
  return (
    <>
      <tr className="bg-fd-background">
        <Cell>
          <div className="flex items-center gap-1" style={{ paddingLeft: depth * 22 }}>
            {depth > 0 && <span className="mr-0.5 text-fd-muted-foreground" aria-hidden="true">└</span>}
            <Chevron open={isOpen} onClick={() => toggle(n.id)} label={`${isOpen ? "Collapse" : "Expand"} ${n.role}`} hidden={tree.kids.length === 0} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{n.role}</p>
              <p className="font-mono text-xs text-fd-muted-foreground">{shortId(n.id)}</p>
            </div>
          </div>
        </Cell>
        <Cell><Badge tone={nodeTone(n)}>{n.state === "working" && n.status === "running" && <span className="live-dot size-1.5 rounded-full bg-current" />}{nodeLabel(n)}</Badge></Cell>
        <Cell className="max-w-[420px]">
          <p className="line-clamp-2 text-sm text-fd-muted-foreground" title={n.result || n.task}>
            {n.result ? n.result : n.task || "—"}
          </p>
        </Cell>
        <Cell>
          <div className="flex items-center gap-1.5">
            <IconButton label="Chat and steer this agent" onClick={() => onChat(n.id)} disabled={!canAct}><MessageSquare className="size-3.5" aria-hidden="true" /></IconButton>
            {n.browser && <IconButton label="Watch the browser live" onClick={() => onBrowser(n.id)} disabled={!canAct}><Globe className="size-3.5" aria-hidden="true" /></IconButton>}
            <IconButton label="Open terminal" onClick={() => onTerminal(n.id)} disabled={!canAct}><SquareTerminal className="size-3.5" aria-hidden="true" /></IconButton>
          </div>
        </Cell>
      </tr>
      {isOpen && tree.kids.map((k) => <NodeRows key={k.node.id} tree={k} depth={depth + 1} open={open} toggle={toggle} list={list} onChat={onChat} onTerminal={onTerminal} onBrowser={onBrowser} />)}
    </>
  );
}

function RunRows({ run, open, toggle, list, onChat, onTerminal, onBrowser, onStop }: {
  run: Run; open: Set<string>; toggle: (id: string) => void; list: Sandbox[];
  onChat: (id: string) => void; onTerminal: (id: string) => void; onBrowser: (id: string) => void; onStop: (run: Run) => void;
}) {
  const isOpen = open.has(run.id);
  const trees = useMemo(() => buildTree(run.nodes), [run.nodes]);
  const active = run.nodes.filter((n) => n.status !== "terminated").length;
  const live = run.status === "starting" || run.status === "running";
  return (
    <>
      <tr className="bg-fd-muted/60">
        <Cell>
          <div className="flex items-center gap-1">
            <Chevron open={isOpen} onClick={() => toggle(run.id)} label={`${isOpen ? "Collapse" : "Expand"} run`} />
            <div className="min-w-0">
              <p className="line-clamp-2 text-sm font-medium" title={run.goal}>{run.goal}</p>
              <p className="mt-0.5 font-mono text-xs text-fd-muted-foreground">{run.id} · {MODELS.find((m) => m.value === run.model)?.label.replace(/ \(.*\)$/, "") ?? run.model} · {active}/{run.maxAgents} containers · {elapsed(run.createdAt, run.finishedAt)}</p>
            </div>
          </div>
        </Cell>
        <Cell><Badge tone={runTone(run.status)}>{live && <span className="live-dot size-1.5 rounded-full bg-current" />}{run.status}</Badge></Cell>
        <Cell className="max-w-[420px]">
          <p className="line-clamp-2 text-sm text-fd-muted-foreground">
            {run.status === "starting" ? "Starting the master agent…" : run.summary || (live ? "Working…" : "—")}
          </p>
        </Cell>
        <Cell>
          <div className="flex items-center gap-1.5">
            <IconButton label="Chat and steer the master" onClick={() => run.masterId && onChat(run.masterId)} disabled={!run.masterId || !live}><MessageSquare className="size-3.5" aria-hidden="true" /></IconButton>
            <IconButton label="Stop and remove all containers" onClick={() => onStop(run)} disabled={run.status === "stopped" || active === 0} destructive><OctagonX className="size-3.5" aria-hidden="true" /></IconButton>
          </div>
        </Cell>
      </tr>
      {isOpen && trees.length === 0 && (
        <tr><td colSpan={4} className="px-4 py-3 pl-12 text-sm text-fd-muted-foreground">{run.status === "starting" ? "Creating the master container…" : "No containers."}</td></tr>
      )}
      {isOpen && trees.map((t) => <NodeRows key={t.node.id} tree={t} depth={1} open={open} toggle={toggle} list={list} onChat={onChat} onTerminal={onTerminal} onBrowser={onBrowser} />)}
    </>
  );
}

export function Agents({ list, onTerminal, onChange }: { list: Sandbox[]; onTerminal: (id: string) => void; onChange: () => void }) {
  const runs = usePoll(api.runs, 2500);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const [chatId, setChatId] = useState<string | null>(null);
  const [browserId, setBrowserId] = useState<string | null>(null);
  const image = usePoll(api.agentImage, 4000);
  const [stopping, setStopping] = useState<Run | null>(null);

  // Open a run, and every agent in it, the first time it shows up. After that the user decides.
  const data = runs.data ?? [];
  useEffect(() => {
    const fresh = data.flatMap((r) => [r.id, ...r.nodes.map((n) => n.id)]).filter((id) => !seen.has(id));
    if (fresh.length === 0) return;
    setSeen((cur) => new Set([...cur, ...fresh]));
    setOpen((cur) => new Set([...cur, ...fresh]));
  }, [data, seen]);
  const toggle = (id: string) => setOpen((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const refresh = () => { void runs.refresh(); onChange(); };

  return (
    <>
      <PageHeader title="Agents" sub="Give a goal to a master agent. It creates containers and agents to reach it. Steer any agent in the tree." />
      <div className="mt-5 flex flex-col gap-5">
        {image.data && image.data.state !== "off" && image.data.state !== "ready" && (
          <p role="status" className="rounded-lg border border-fd-border bg-fd-muted px-4 py-2.5 text-sm text-fd-muted-foreground">
            {image.data.state === "building" ? "Preparing the agent image: Pi and a browser are being installed once and cached. The first goal waits for it, and later ones start in seconds."
              : image.data.state === "error" ? `The agent image could not be built: ${image.data.detail ?? "unknown error"}`
              : "The agent image is not built yet. It builds the first time a goal starts."}
          </p>
        )}
        <NewGoal onStarted={refresh} />
        <Card className="overflow-hidden">
          {runs.data === undefined ? <Empty title="Loading…" /> : data.length === 0 ? (
            <Empty title="No goals yet" hint="Start a goal above. Each run shows here as a tree of the containers it creates." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="border-b border-fd-border bg-fd-muted text-xs text-fd-muted-foreground">
                  <tr>{["Goal and agents", "Status", "Task, then result", "Actions"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-fd-border">
                  {data.map((r) => <RunRows key={r.id} run={r} open={open} toggle={toggle} list={list} onChat={setChatId} onTerminal={onTerminal} onBrowser={setBrowserId} onStop={setStopping} />)}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      <BrowserView sandbox={browserId ? list.find((s) => s.id === browserId) ?? null : null} onClose={() => setBrowserId(null)} />
      <ChatPanel sandbox={chatId ? list.find((s) => s.id === chatId) ?? null : null} onClose={() => setChatId(null)} onChange={refresh} />
      <ConfirmDialog
        open={stopping !== null}
        onOpenChange={(o) => { if (!o) setStopping(null); }}
        title="Stop this goal?"
        description={<>This stops every agent in <span className="chip-code">{stopping?.id}</span> and deletes its containers. Their files are lost.</>}
        confirmLabel="Stop and remove"
        onConfirm={() => { const r = stopping; if (r) void act("Goal stopped", () => api.stopRun(r.id), refresh); }}
      />
    </>
  );
}
