import { useMemo } from "react";
import { Button } from "@ui-sdk/react/button";
import type { Sandbox, Status } from "../api";
import { Badge, Card, Empty, PageHeader, StatusBadge, cx, shortId } from "../lib";
import { SandboxActions } from "./actions";

const NODE_W = 188, NODE_H = 56, GAP_X = 72, GAP_Y = 24, PAD = 16;

function Topology({ list, selectedId, onSelect }: { list: Sandbox[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const layout = useMemo(() => {
    const byDepth = new Map<number, Sandbox[]>();
    for (const s of list) byDepth.set(s.depth, [...(byDepth.get(s.depth) ?? []), s]);
    const pos = new Map<string, { x: number; y: number }>();
    let maxRows = 0, maxDepth = 0;
    for (const [d, items] of byDepth) {
      maxDepth = Math.max(maxDepth, d);
      maxRows = Math.max(maxRows, items.length);
      items.forEach((s, i) => pos.set(s.id, { x: PAD + d * (NODE_W + GAP_X), y: PAD + i * (NODE_H + GAP_Y) }));
    }
    return { pos, w: PAD * 2 + (maxDepth + 1) * NODE_W + maxDepth * GAP_X, h: PAD * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * GAP_Y };
  }, [list]);

  return (
    <div className="overflow-auto">
      <svg width={layout.w} height={layout.h} role="img" aria-label="Sandbox lineage graph" className="min-w-full">
        {list.map((s) => {
          const a = s.parentId ? layout.pos.get(s.parentId) : undefined;
          const b = layout.pos.get(s.id);
          if (!a || !b) return null;
          const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, mx = (x1 + x2) / 2;
          return <path key={`e-${s.id}`} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="#d4d4d8" strokeWidth="1.5" strokeDasharray="4 3" />;
        })}
        {list.map((s) => {
          const p = layout.pos.get(s.id)!;
          const sel = s.id === selectedId;
          const dot = s.status === "running" ? "#059669" : "#d97706";
          return (
            <g key={s.id} transform={`translate(${p.x},${p.y})`} onClick={() => onSelect(s.id)} className="cursor-pointer" tabIndex={0} role="button" aria-label={`${s.role} ${s.status}`}
               onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(s.id); } }}>
              <rect width={NODE_W} height={NODE_H} rx="8" fill="#fff" stroke={sel ? "#7a1b48" : "#e4e4e7"} strokeWidth={sel ? 2 : 1} />
              <circle cx="16" cy="20" r="4" fill={dot} />
              <text x="28" y="24" fontSize="13" fontWeight="600" fill="#111">{s.role.length > 18 ? `${s.role.slice(0, 17)}…` : s.role}</text>
              <text x="16" y="43" fontSize="11" fill="#71717a" fontFamily="Geist Mono, monospace">{shortId(s.id)} · {s.cpuLimitMilli}m · {s.memLimitMi}Mi</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-fd-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-fd-muted-foreground">{hint}</p>}
    </Card>
  );
}

export function Overview({ status, list, selected, onSelect, onTerminal, onChange, go, loading }: {
  status: Status | undefined; list: Sandbox[]; selected: Sandbox | null; onSelect: (id: string) => void;
  onTerminal: (id: string) => void; onChange: () => void; go: (s: "security") => void; loading: boolean;
}) {
  const f = status?.fleet;
  return (
    <>
      <PageHeader title="Overview" sub="Live state of your sandbox fleet. Every node is a real OpenSandbox container." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sandboxes" value={f?.total ?? "–"} hint={f ? `${f.running} running · ${f.paused} paused` : undefined} />
        <Stat label="Pending egress approvals" value={f?.pendingGates ?? "–"} hint="Recorded requests awaiting a decision" />
        <Stat label="Workflow slots in use" value={f ? `${f.activeWorkflowSlots}/4` : "–"} hint={f ? `${f.queuedJobs} queued` : undefined} />
        <Stat label="Storage adapter" value={status?.daemon.adapter ?? "–"} hint={status ? `Up ${Math.floor(status.daemon.uptimeSeconds / 60)}m` : undefined} />
      </div>

      {(f?.pendingGates ?? 0) > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-warn-soft px-4 py-3 text-sm">
          <span><strong className="font-semibold">{f!.pendingGates} egress request{f!.pendingGates > 1 ? "s" : ""}</strong> waiting for your decision.</span>
          <Button onClick={() => go("security")}>Review</Button>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <div className="flex items-center justify-between border-b border-fd-border px-4 py-3">
            <h2 className="h-section">Execution topology</h2>
            <span className="text-xs text-fd-muted-foreground">Dashed edges show fork lineage</span>
          </div>
          {loading ? <Empty title="Loading…" /> : list.length === 0 ? (
            <Empty title="No sandboxes yet" hint="Spawn one to create a real container, then fork it to see the lineage graph." />
          ) : (
            <Topology list={list} selectedId={selected?.id ?? null} onSelect={onSelect} />
          )}
        </Card>

        <Card className="self-start">
          <div className="border-b border-fd-border px-4 py-3"><h2 className="h-section">Inspector</h2></div>
          {!selected ? (
            <Empty title="Select a node" hint="Click a sandbox in the graph to inspect and control it." />
          ) : (
            <div className="flex flex-col gap-4 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{selected.role}</p>
                  <p className="truncate font-mono text-xs text-fd-muted-foreground">{selected.id}</p>
                </div>
                <StatusBadge status={selected.status} />
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {[
                  ["Uptime", selected.uptime],
                  ["Model", selected.modelProvider],
                  ["CPU limit", `${selected.cpuLimitMilli}m`],
                  ["Memory limit", `${selected.memLimitMi}Mi`],
                  ["Checkpoint", selected.checkpointId ? selected.checkpointId.slice(0, 8) : "none"],
                  ["Saved", selected.checkpointAgo],
                ].map(([k, v]) => (
                  <div key={k}><dt className="text-xs text-fd-muted-foreground">{k}</dt><dd className="truncate font-mono text-[13px]">{v}</dd></div>
                ))}
              </dl>
              <div className="flex flex-wrap gap-1">{selected.mcpTools.map((t) => <Badge key={t} tone="brand" mono>{t}</Badge>)}</div>
              <SandboxActions sb={selected} onTerminal={onTerminal} onChange={onChange} />
              <div>
                <h3 className="h-section mb-2">Recent commands</h3>
                {selected.recentExecs.length === 0 ? <p className="text-sm text-fd-muted-foreground">No commands yet. Open the terminal to run one.</p> : (
                  <ul className="flex flex-col gap-1">
                    {selected.recentExecs.slice(0, 5).map((e, i) => (
                      <li key={i} className="flex items-center gap-2 font-mono text-xs">
                        <span className={cx("size-1.5 rounded-full", e.exit === 0 ? "bg-ok" : "bg-bad")} />
                        <span className="min-w-0 flex-1 truncate">{e.cmd}</span>
                        <span className="text-fd-muted-foreground">{e.dur}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>
      <p className="text-xs text-fd-muted-foreground">Live CPU and memory usage are not wired yet, so only the configured limits are shown.</p>
    </>
  );
}
