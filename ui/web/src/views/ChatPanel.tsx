import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@ui-sdk/react/button";
import { Drawer, DrawerBackdrop, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from "@ui-sdk/react/drawer";
import { Textarea } from "@ui-sdk/react/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { Square, X } from "lucide-react";
import { api, promptAgent, type AgentFrame, type Sandbox, type TranscriptRow } from "../api";
import { StatusBadge, toast } from "../lib";

type Msg =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "tool"; id: string; tool: string; input: string; output?: string; isError?: boolean }
  | { kind: "note"; text: string }
  | { kind: "steer"; label: string; text: string; results: { sandboxId: string; delivered: boolean; reason?: string }[] }
  | { kind: "error"; text: string };

/** Turn the server's saved rows into messages. The server keeps every agent's thread, including a background agent's. */
function fromRows(rows: TranscriptRow[]): Msg[] {
  const out: Msg[] = [];
  for (const r of rows) {
    if (r.kind === "user") out.push({ kind: "user", text: r.text });
    else if (r.kind === "agent") out.push({ kind: "agent", text: r.text });
    else if (r.kind === "note") out.push({ kind: "note", text: r.text });
    else if (r.kind === "error") out.push({ kind: "error", text: r.text });
    else if (r.kind === "tool") {
      try {
        const d = JSON.parse(r.text) as { tool: string; input: string; output?: string; isError?: boolean };
        out.push({ kind: "tool", id: r.ref ?? String(r.id), tool: d.tool, input: pretty(d.input), output: d.output === undefined ? undefined : pretty(d.output), isError: d.isError });
      } catch { /* skip a malformed row */ }
    } else if (r.kind === "steer") {
      try {
        const d = JSON.parse(r.text) as { label: string; text: string; results: { sandboxId: string; delivered: boolean; reason?: string }[] };
        out.push({ kind: "steer", label: d.label, text: d.text, results: d.results });
      } catch { /* skip a malformed row */ }
    }
  }
  return out;
}

function modelLabel(id: string): string {
  return id.split("-").map((p, i) => (i === 0 ? "Gemini" : p === "flash" || p === "pro" || p === "medium" ? p[0]!.toUpperCase() + p.slice(1) : p)).join(" ");
}

function pretty(json: string): string {
  try {
    const v = JSON.parse(json);
    if (v && typeof v === "object") {
      if (typeof v.command === "string") return v.command;
      if (typeof v.path === "string") return v.path;
      const text = v.content?.[0]?.text;
      if (typeof text === "string") return text.trim() || "(no output)";
    }
  } catch { /* not JSON */ }
  return json;
}

/** Chat with the agent in a sandbox. Steering a parent can reach its child agents too. */
export function ChatPanel({ sandbox, onClose, onChange }: { sandbox: Sandbox | null; onClose: () => void; onChange: () => void }) {
  const id = sandbox?.id ?? "";
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [withChildren, setWithChildren] = useState(false);
  const [children, setChildren] = useState<Sandbox[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Load the saved thread when the panel opens on a sandbox, and keep it current while no local prompt is streaming.
  const runningRef = useRef(false);
  runningRef.current = running;
  useEffect(() => {
    if (!id) return;
    let live = true;
    const load = () => api.transcript(id).then((rows) => { if (live && !runningRef.current) setMsgs(fromRows(rows)); }).catch(() => {});
    setMsgs([]);
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => { live = false; clearInterval(t); };
  }, [id]);

  // Find the sandbox's descendants, for the steer-the-subtree option.
  useEffect(() => {
    if (!id) return;
    setText("");
    setWithChildren(false);
    let live = true;
    api.sandboxes().then((all) => {
      if (!live) return;
      const out: Sandbox[] = [];
      const walk = (pid: string) => { for (const s of all.filter((x) => x.parentId === pid)) { out.push(s); walk(s.id); } };
      walk(id);
      setChildren(out);
    }).catch(() => {});
    return () => { live = false; };
  }, [id]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [msgs]);

  function update(fn: (m: Msg[]) => Msg[]) {
    setMsgs(fn);
  }

  function onFrame(f: AgentFrame) {
    update((cur) => {
      const m = [...cur];
      const last = m[m.length - 1];
      if (f.type === "text") {
        if (last?.kind === "agent") m[m.length - 1] = { kind: "agent", text: last.text + f.text };
        else m.push({ kind: "agent", text: f.text });
      } else if (f.type === "tool_start") {
        m.push({ kind: "tool", id: f.id, tool: f.tool, input: pretty(f.input) });
      } else if (f.type === "tool_end") {
        const i = m.findIndex((x) => x.kind === "tool" && x.id === f.id);
        if (i >= 0) m[i] = { ...(m[i] as Extract<Msg, { kind: "tool" }>), output: pretty(f.output), isError: f.isError };
      } else if (f.type === "note") {
        m.push({ kind: "note", text: f.text });
      } else if (f.type === "error") {
        m.push({ kind: "error", text: f.message });
      }
      return m;
    });
  }

  async function send() {
    const message = text.trim();
    if (!message || !sandbox || running) return;
    setText("");
    update((cur) => [...cur, { kind: "user", text: message }]);
    setRunning(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      await promptAgent(sandbox.id, message, onFrame, ctl.signal);
    } catch (err) {
      if (!ctl.signal.aborted) update((cur) => [...cur, { kind: "error", text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setRunning(false);
      abortRef.current = null;
      // Show what the server saved, which now includes this turn.
      api.transcript(id).then((rows) => setMsgs(fromRows(rows))).catch(() => {});
      onChange();
    }
  }

  async function steer(mode: "steer" | "followUp" | "abort") {
    if (!sandbox) return;
    const message = text.trim();
    if (mode !== "abort" && !message) return;
    const scope = withChildren ? "subtree" : "node";
    try {
      const r = await api.steerAgent(sandbox.id, message, scope, mode);
      const label = mode === "abort" ? "Stopped" : mode === "followUp" ? "Queued" : "Steered";
      update((cur) => [...cur, { kind: "steer", label, text: message, results: r.results }]);
      if (mode !== "abort") setText("");
      const ok = r.results.filter((x) => x.delivered).length;
      if (ok === 0) toast.error(r.results[0]?.reason ? `Not delivered: ${r.results[0].reason}` : "Not delivered");
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (running) void steer("steer"); else void send();
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (running) void steer("steer"); else void send(); }
  }

  const names = useMemo(() => new Map([[id, sandbox?.role ?? id], ...children.map((c) => [c.id, c.role] as [string, string])]), [id, sandbox?.role, children]);
  const hasAgent = Boolean(sandbox?.agent);
  const childAgents = children.filter((c) => c.agent).length;
  const canSend = sandbox?.status === "running" && hasAgent;

  return (
    <Drawer open={sandbox !== null} onOpenChange={(o) => { if (!o) onClose(); }} side="right">
      <DrawerBackdrop />
      <DrawerContent className="flex h-full w-[min(560px,100vw)] flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <div data-slot="stack" className="min-w-0">
            <DrawerTitle className="h-section truncate">Chat · {sandbox?.role ?? "Agent"}</DrawerTitle>
            <DrawerDescription className="truncate text-xs text-fd-muted-foreground">
              {sandbox ? modelLabel(sandbox.modelProvider) : ""}
              {children.length > 0 ? ` · ${children.length} child sandbox${children.length === 1 ? "" : "es"}, ${childAgents} with an agent` : ""}
            </DrawerDescription>
          </div>
          <div className="flex items-center gap-2">
            {sandbox && <StatusBadge status={sandbox.status} />}
            <Tooltip delay={250}>
              <TooltipTrigger render={<DrawerClose aria-label="Close chat" />}><X className="size-4" aria-hidden="true" /></TooltipTrigger>
              <TooltipContent side="bottom" className="rounded-md bg-fd-foreground px-2 py-1 text-xs font-medium text-white">Close</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-fd-border bg-fd-muted p-3">
          {!hasAgent ? (
            <p className="p-2 text-sm text-fd-muted-foreground">This sandbox has no agent. Spawn a new sandbox to chat: new sandboxes start with an agent.</p>
          ) : msgs.length === 0 ? (
            <p className="p-2 text-sm text-fd-muted-foreground">
              Ask the agent to do something in its sandbox. While it works, you can steer it, queue a follow-up, or stop it.
            </p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {msgs.map((m, i) => {
                if (m.kind === "user") return <div key={i} className="ml-8 self-end rounded-lg bg-fd-foreground px-3 py-2 text-sm text-white whitespace-pre-wrap">{m.text}</div>;
                if (m.kind === "agent") return <div key={i} className="mr-8 rounded-lg border border-fd-border bg-fd-background px-3 py-2 text-sm whitespace-pre-wrap">{m.text}</div>;
                if (m.kind === "note") return <p key={i} className="text-center text-xs text-fd-muted-foreground">{m.text}</p>;
                if (m.kind === "error") return <p key={i} role="alert" className="rounded-md border border-fd-border bg-fd-background px-3 py-2 text-sm text-fd-primary">{m.text}</p>;
                if (m.kind === "steer") {
                  const ok = m.results.filter((r) => r.delivered).length;
                  return (
                    <div key={i} className="rounded-md border border-fd-border bg-fd-background px-3 py-2 text-xs">
                      <p className="font-medium">{m.label}{m.text ? `: ${m.text}` : ""}</p>
                      <p className="mt-1 text-fd-muted-foreground">Delivered to {ok} of {m.results.length} agent{m.results.length === 1 ? "" : "s"}.</p>
                      {m.results.length > 1 && (
                        <ul className="mt-1 space-y-0.5 text-fd-muted-foreground">
                          {m.results.map((r) => <li key={r.sandboxId}>{names.get(r.sandboxId) ?? r.sandboxId.slice(0, 8)}: {r.delivered ? "delivered" : r.reason}</li>)}
                        </ul>
                      )}
                    </div>
                  );
                }
                return (
                  <div key={i} className="mr-8 rounded-md border border-fd-border bg-fd-background px-3 py-2 font-mono text-xs">
                    <p className="text-fd-muted-foreground">{m.tool}</p>
                    <p className="mt-0.5 whitespace-pre-wrap break-words">{m.input}</p>
                    {m.output !== undefined && <pre className={`mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words border-t border-fd-border pt-1.5 ${m.isError ? "text-fd-primary" : "text-fd-muted-foreground"}`}>{m.output}</pre>}
                  </div>
                );
              })}
              {running && <p className="text-xs text-fd-muted-foreground" aria-live="polite">Working…</p>}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <form onSubmit={submit} className="flex flex-col gap-2">
          {children.length > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-[#7a1b48]" checked={withChildren} onChange={(e) => setWithChildren(e.target.checked)} />
              Steer, queue and stop reach this agent and its {children.length} child sandbox{children.length === 1 ? "" : "es"}
            </label>
          )}
          <Textarea
            value={text}
            onValueChange={setText}
            onKeyDown={onKey}
            rows={3}
            disabled={!canSend}
            placeholder={!canSend ? (hasAgent ? "Resume the sandbox to chat" : "No agent in this sandbox") : running ? "Steer the agent while it works…" : "Ask the agent to do something…"}
            aria-label="Message to the agent"
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {running ? (
              <>
                <Button type="button" className="btn-sm inline-flex items-center gap-1.5" onClick={() => void steer("abort")}><Square className="size-3.5" aria-hidden="true" /><span>Stop</span></Button>
                <Button type="button" className="btn-sm" onClick={() => void steer("followUp")} disabled={!text.trim()}>Queue next</Button>
                <Button type="submit" data-variant="solid" className="btn-sm" disabled={!text.trim()}>Steer now</Button>
              </>
            ) : (
              <>
                {children.length > 0 && <Button type="button" className="btn-sm" onClick={() => void steer("followUp")} disabled={!canSend || !text.trim()}>Send to all agents</Button>}
                <Button type="submit" data-variant="solid" className="btn-sm" disabled={!canSend || !text.trim()}>Send</Button>
              </>
            )}
          </div>
        </form>
      </DrawerContent>
    </Drawer>
  );
}
