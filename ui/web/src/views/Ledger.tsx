import { useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { api, type LedgerEvent } from "../api";
import { Badge, Card, Empty, PageHeader, act, clock, shortId, usePoll } from "../lib";

const FILTERS = ["all", "exec_start", "exec_event", "checkpoint", "exec_complete"];
const tone = (t: string) => (t === "checkpoint" ? "brand" : t === "exec_complete" ? "ok" : t === "exec_event" ? "info" : "neutral") as "brand" | "ok" | "info" | "neutral";

export function Ledger() {
  const [type, setType] = useState("all");
  const [replayed, setReplayed] = useState<LedgerEvent[] | null>(null);
  const { data, refresh } = usePoll(() => api.ledger(type), 4000, [type]);
  const events = (data ?? []).slice().reverse();

  return (
    <>
      <PageHeader title="Audit ledger" sub="Append-only record of every spawn, command, fork and checkpoint.">
        <Button onClick={() => void refresh()}>Refresh</Button>
      </PageHeader>
      <SegmentedControl aria-label="Event type" value={type} onValueChange={(v) => { if (v) { setType(v); setReplayed(null); } }} className="self-start">
        <SegmentedControlIndicator />
        {FILTERS.map((f) => <SegmentedControlItem key={f} value={f}>{f === "all" ? "All events" : f}</SegmentedControlItem>)}
      </SegmentedControl>

      <Card className="overflow-hidden">
        {data === undefined ? <Empty title="Loading…" /> : events.length === 0 ? (
          <Empty title="No events yet" hint="Spawning a sandbox or running a command writes the first entry." />
        ) : (
          <ol className="divide-y divide-fd-border bg-fd-background">
            {events.map((e) => (
              <li key={e.seq} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <span className="w-10 font-mono text-xs text-fd-muted-foreground">#{e.seq}</span>
                <span className="w-[68px] font-mono text-xs text-fd-muted-foreground">{clock(e.ts)}</span>
                <Badge tone={tone(e.type)} mono>{e.type}</Badge>
                <span className="font-mono text-xs font-medium">{e.tool}</span>
                <span className="min-w-0 flex-1 basis-64 truncate text-fd-muted-foreground" title={e.detail}>{e.detail}</span>
                <span className="font-mono text-xs text-fd-muted-foreground">{shortId(e.sandbox_id)}</span>
                <Button className="btn-sm" onClick={() => void act("Replayed", async () => { const r = await api.replay(e.seq); setReplayed(r.replayedEvents); })}>Replay from here</Button>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {replayed && (
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between"><h2 className="h-section">Replay · {replayed.length} events</h2><Button className="btn-sm" onClick={() => setReplayed(null)}>Close</Button></div>
          <pre className="m-0 max-h-72 overflow-auto rounded-lg bg-fd-muted p-3 font-mono text-xs leading-5">{replayed.map((e) => `#${e.seq} ${clock(e.ts)} ${e.type.padEnd(13)} ${e.tool.padEnd(10)} ${e.detail}`).join("\n")}</pre>
          <p className="mt-2 text-xs text-fd-muted-foreground">Replay reads recorded events in order. It does not re-run any command.</p>
        </Card>
      )}
    </>
  );
}
