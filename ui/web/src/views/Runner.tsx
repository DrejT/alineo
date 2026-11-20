import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@ui-sdk/react/button";
import { api } from "../api";
import { Card, PageHeader, cx, toast } from "../lib";

const EXAMPLES = ["alineo status", "alineo spawn --role reviewer --cpu 250 --mem 256", "alineo memory recall \"jwt\"", "alineo workflow flush"];
interface Run { cmd: string; out: string; code: number; ms: number }

export function Runner({ onChange }: { onChange: () => void }) {
  const [cmd, setCmd] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [runs.length]);

  async function run(c: string) {
    if (!c.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.cli(c.trim());
      setRuns((x) => [...x, { cmd: c.trim(), out: r.output, code: r.exitCode, ms: r.durationMs }]);
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); setCmd(""); }
  }

  return (
    <>
      <PageHeader title="Runner" sub="Run alineo commands against the control plane. Spawn and fork start real containers." />
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((e) => <button key={e} type="button" onClick={() => setCmd(e)} className="chip-code cursor-pointer hover:bg-fd-primary-soft">{e}</button>)}
      </div>
      <Card className="flex h-[min(520px,60vh)] flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-5">
          {runs.length === 0 && <p className="text-fd-muted-foreground">Output appears here. Pick an example above or type a command.</p>}
          {runs.map((r, i) => (
            <div key={i} className="mb-3"><p><span className="text-fd-primary">$</span> {r.cmd}</p><pre className={cx("m-0 whitespace-pre-wrap break-words", r.code === 0 ? "" : "text-bad")}>{r.out}</pre><p className="text-[11px] text-fd-muted-foreground">exit {r.code} · {r.ms}ms</p></div>
          ))}
          <div ref={end} />
        </div>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); void run(cmd); }} className="flex items-center gap-2 border-t border-fd-border bg-fd-background p-3">
          <span className="font-mono text-fd-primary" aria-hidden="true">$</span>
          <input value={cmd} onChange={(e) => setCmd(e.target.value)} aria-label="alineo command" placeholder="alineo status" disabled={busy}
            className="h-9 min-w-0 flex-1 rounded-md border border-fd-border bg-fd-background px-3 font-mono text-sm outline-none focus:border-fd-primary focus:ring-2 focus:ring-fd-primary/15" />
          <Button type="submit" data-variant="solid" disabled={busy || !cmd.trim()}>{busy ? "Running…" : "Run"}</Button>
        </form>
      </Card>
    </>
  );
}
