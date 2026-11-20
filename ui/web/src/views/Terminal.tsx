import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@ui-sdk/react/button";
import { Drawer, DrawerBackdrop, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from "@ui-sdk/react/drawer";
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import { Textarea } from "@ui-sdk/react/textarea";
import { X } from "lucide-react";
import { api, type Sandbox } from "../api";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { StatusBadge, act, cx } from "../lib";

interface Entry { cmd: string; out: string; code: number; ms: number }

export function TerminalDrawer({ sandbox, onClose, onChange }: { sandbox: Sandbox | null; onClose: () => void; onChange: () => void }) {
  const [history, setHistory] = useState<Record<string, Entry[]>>({});
  const [cmd, setCmd] = useState("");
  const [busy, setBusy] = useState(false);
  const [directive, setDirective] = useState("");
  const [scope, setScope] = useState("node");
  const endRef = useRef<HTMLDivElement>(null);
  const id = sandbox?.id ?? "";
  const entries = history[id] ?? [];
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [entries.length, id]);

  async function run(e: FormEvent) {
    e.preventDefault();
    const c = cmd.trim();
    if (!c || !sandbox || busy) return;
    setBusy(true);
    setCmd("");
    try {
      const r = await api.exec(sandbox.id, c);
      setHistory((h) => ({ ...h, [sandbox.id]: [...(h[sandbox.id] ?? []), { cmd: c, out: r.stdout, code: r.exitCode, ms: r.durationMs }] }));
      onChange();
    } catch (err) {
      setHistory((h) => ({ ...h, [sandbox.id]: [...(h[sandbox.id] ?? []), { cmd: c, out: err instanceof Error ? err.message : String(err), code: 1, ms: 0 }] }));
    } finally { setBusy(false); }
  }

  async function steer() {
    if (!sandbox || !directive.trim()) return;
    const r = await act("Directive sent", () => api.steer(sandbox.id, directive.trim(), scope), onChange);
    if (r) setDirective("");
  }

  return (
    <Drawer open={sandbox !== null} onOpenChange={(o) => { if (!o) onClose(); }} side="right">
      <DrawerBackdrop />
      <DrawerContent className="flex h-full w-[min(640px,100vw)] flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div data-slot="stack" className="min-w-0">
            <DrawerTitle className="h-section truncate">{sandbox?.role ?? "Terminal"}</DrawerTitle>
            <DrawerDescription className="truncate font-mono text-xs text-fd-muted-foreground">{sandbox?.id}</DrawerDescription>
          </div>
          <div className="flex items-center gap-2">
            {sandbox && <StatusBadge status={sandbox.status} />}
            <Tooltip delay={250}>
              <TooltipTrigger render={<DrawerClose aria-label="Close terminal" />}><X className="size-4" aria-hidden="true" /></TooltipTrigger>
              <TooltipContent side="bottom" className="rounded-md bg-fd-foreground px-2 py-1 text-xs font-medium text-white">Close</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <Tabs defaultValue="terminal" className="flex min-h-0 flex-1 flex-col">
          <TabsList aria-label="Sandbox tools">
            <TabsTab value="terminal">Terminal</TabsTab>
            <TabsTab value="steer">Steer</TabsTab>
          </TabsList>

          <TabsPanel value="terminal" className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-fd-border bg-fd-card p-3 font-mono text-[12.5px] leading-5">
              {entries.length === 0 && <p className="text-fd-muted-foreground">Commands run inside this container, not on your machine. Try <span className="chip-code">uname -a</span>.</p>}
              {entries.map((en, i) => (
                <div key={i} className="mb-3">
                  <p><span className="text-fd-primary">$</span> {en.cmd}</p>
                  <pre className={cx("m-0 whitespace-pre-wrap break-words", en.code === 0 ? "text-fd-foreground" : "text-bad")}>{en.out}</pre>
                  <p className="text-[11px] text-fd-muted-foreground">exit {en.code} · {en.ms}ms</p>
                </div>
              ))}
              <div ref={endRef} />
            </div>
            <form onSubmit={run} className="flex items-center gap-2">
              <span className="font-mono text-fd-primary" aria-hidden="true">$</span>
              <input value={cmd} onChange={(e) => setCmd(e.target.value)} disabled={busy || sandbox?.status !== "running"} aria-label="Command"
                placeholder={sandbox?.status === "running" ? "Run a command…" : "Resume the sandbox to run commands"}
                className="h-9 min-w-0 flex-1 rounded-md border border-fd-border bg-fd-background px-3 font-mono text-sm outline-none focus:border-fd-primary focus:ring-2 focus:ring-fd-primary/15 disabled:opacity-60" />
              <Button type="submit" data-variant="solid" disabled={busy || !cmd.trim() || sandbox?.status !== "running"}>{busy ? "Running…" : "Run"}</Button>
            </form>
          </TabsPanel>

          <TabsPanel value="steer" className="flex flex-col gap-4">
            <p className="text-sm text-fd-muted-foreground">Send a directive. It is recorded in the ledger and the sandbox log. Nothing changes inside the container.</p>
            <Textarea value={directive} onValueChange={setDirective} placeholder="e.g. Enforce strict token verification" aria-label="Directive" rows={4} />
            <div className="flex items-center justify-between gap-3">
              <SegmentedControl aria-label="Scope" value={scope} onValueChange={(v) => v && setScope(v)}>
                <SegmentedControlIndicator />
                <SegmentedControlItem value="node">This node</SegmentedControlItem>
                <SegmentedControlItem value="subtree">Subtree</SegmentedControlItem>
                <SegmentedControlItem value="fleet">Fleet</SegmentedControlItem>
              </SegmentedControl>
              <Button data-variant="solid" onClick={() => void steer()} disabled={!directive.trim()}>Send directive</Button>
            </div>
          </TabsPanel>
        </Tabs>
      </DrawerContent>
    </Drawer>
  );
}
