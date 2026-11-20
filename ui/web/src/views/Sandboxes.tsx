import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@ui-sdk/react/button";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@ui-sdk/react/dialog";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Select, SelectContent, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@ui-sdk/react/select";
import { api, type Sandbox } from "../api";
import { Card, Empty, PageHeader, StatusBadge, act, shortId } from "../lib";
import { SandboxActions } from "./actions";

export const MODELS = [
  { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash (default)" },
  { value: "gemini-3.8-pro", label: "Gemini 3.8 Pro" },
  { value: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash Medium" },
  { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { value: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
  { value: "groq-gemma-2-9b", label: "Gemma 2 9B (Groq)" },
];
const CPUS = [{ value: "250", label: "250m (0.25 vCPU)" }, { value: "500", label: "500m (0.5 vCPU)" }, { value: "1000", label: "1000m (1 vCPU)" }, { value: "2000", label: "2000m (2 vCPU)" }];
const MEMS = [{ value: "256", label: "256Mi" }, { value: "512", label: "512Mi" }, { value: "1024", label: "1024Mi" }];
const TOOLS = ["GitHub", "Slack", "Postgres", "Filesystem"];

function Pick({ label, value, onChange, items }: { label: string; value: string; onChange: (v: string) => void; items: { value: string; label: string }[] }) {
  return (
    // Select renders its label and trigger as siblings with no wrapper, so give them one.
    <div className="flex min-w-0 flex-col gap-1.5">
      <Select items={items} value={value} onValueChange={(v) => v && onChange(v)}>
        <SelectLabel>{label}</SelectLabel>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{items.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

export function SpawnDialog({ open, onOpenChange, list, parentId, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; list: Sandbox[]; parentId: string | null; onDone: (sb: Sandbox) => void;
}) {
  const [role, setRole] = useState("agent-worker");
  const [cpu, setCpu] = useState("500");
  const [mem, setMem] = useState("512");
  const [model, setModel] = useState(MODELS[0]!.value);
  const [tools, setTools] = useState<string[]>(["Filesystem"]);
  const [busy, setBusy] = useState(false);
  const parent = parentId ? list.find((s) => s.id === parentId) : undefined;
  useEffect(() => { if (open) setBusy(false); }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const sb = await act("Sandbox ready", () => api.spawn({ role: role.trim() || "agent-worker", parentId: parent?.id ?? null, cpuLimitMilli: Number(cpu), memLimitMi: Number(mem), modelProvider: model, mcpTools: tools }));
    setBusy(false);
    if (sb) { onOpenChange(false); onDone(sb); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBackdrop />
      <DialogContent className="w-[min(480px,94vw)] p-5">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div data-slot="stack">
            <DialogTitle className="h-section">Spawn sandbox</DialogTitle>
            <DialogDescription className="text-sm text-fd-muted-foreground">
              Starts a new container through OpenSandbox. The first start can take a moment while the image is pulled.
            </DialogDescription>
          </div>
          <Field><FieldLabel>Role</FieldLabel><Input value={role} onValueChange={setRole} placeholder="agent-worker" /></Field>
          {parent && <p className="text-sm text-fd-muted-foreground">Parent: <span className="chip-code">{parent.role}</span> (lineage only; use Fork to copy its filesystem)</p>}
          <div className="grid grid-cols-2 gap-3">
            <Pick label="CPU" value={cpu} onChange={setCpu} items={CPUS} />
            <Pick label="Memory" value={mem} onChange={setMem} items={MEMS} />
          </div>
          <Pick label="Model" value={model} onChange={setModel} items={MODELS} />
          <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5">
            <legend className="mb-1.5 text-sm font-medium">Tool access</legend>
            {TOOLS.map((t) => (
              <label key={t} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-[#7a1b48]" checked={tools.includes(t)} onChange={(e) => setTools(e.target.checked ? [...tools, t] : tools.filter((x) => x !== t))} />{t}
              </label>
            ))}
          </fieldset>
          <div data-slot="row" className="mt-1">
            <DialogClose type="button">Cancel</DialogClose>
            <Button type="submit" data-variant="solid" disabled={busy}>{busy ? "Starting container…" : "Spawn"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Sandboxes({ list, onTerminal, onChange, loading }: {
  list: Sandbox[]; onTerminal: (id: string) => void; onChange: () => void; loading: boolean;
}) {
  return (
    <>
      <PageHeader title="Sandboxes" sub="Create, pause, fork, checkpoint and terminate real containers." />
      <Card className="overflow-hidden">
        {loading ? <Empty title="Loading…" /> : list.length === 0 ? (
          <Empty title="No sandboxes yet" hint="Spawn a sandbox to start a container you can run commands in." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-fd-border bg-fd-muted text-xs text-fd-muted-foreground">
                <tr>{["Sandbox", "Status", "Limits", "Parent", "Checkpoint", "Uptime", "Actions"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-fd-border bg-fd-background">
                {list.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-3"><p className="font-medium">{s.role}</p><p className="font-mono text-xs text-fd-muted-foreground">{shortId(s.id)}</p></td>
                    <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
                    <td className="px-4 py-3 font-mono text-xs">{s.cpuLimitMilli}m · {s.memLimitMi}Mi</td>
                    <td className="px-4 py-3 font-mono text-xs text-fd-muted-foreground">{s.parentId ? shortId(s.parentId) : "root"}</td>
                    <td className="px-4 py-3 font-mono text-xs text-fd-muted-foreground">{s.checkpointId ? `${s.checkpointId.slice(0, 8)} · ${s.checkpointAgo}` : "none"}</td>
                    <td className="px-4 py-3 font-mono text-xs">{s.uptime}</td>
                    <td className="px-4 py-3"><SandboxActions sb={s} compact onTerminal={onTerminal} onChange={onChange} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
