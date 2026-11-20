import { useState, type FormEvent } from "react";
import { Button } from "@ui-sdk/react/button";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@ui-sdk/react/dialog";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../api";
import { Badge, Card, Empty, IconButton, PageHeader, StatusBadge, act, clock, cx, shortId, usePoll } from "../lib";

function Egress({ onChange }: { onChange: () => void }) {
  const { data, refresh } = usePoll(api.gates, 4000);
  const done = () => { void refresh(); onChange(); };
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-fd-border px-4 py-3"><h2 className="h-section">Egress approvals</h2><p className="text-sm text-fd-muted-foreground">Requests recorded for your decision. Allowing one resumes a paused sandbox. Network traffic is not intercepted yet.</p></div>
      {!data?.length ? <Empty title="No egress requests" hint="Requests are recorded through the API (POST /api/security/egress)." /> : (
        <ul className="divide-y divide-fd-border bg-fd-background">
          {data.map((g) => (
            <li key={g.gateId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm">
              <StatusBadge status={g.status} />
              <span className="font-mono text-xs font-medium">{g.targetHost}</span><Badge mono>{g.protocol}</Badge>
              <span className="min-w-0 flex-1 basis-56 text-fd-muted-foreground">{g.reason}</span>
              <span className="font-mono text-xs text-fd-muted-foreground">{shortId(g.sandboxId)} · {clock(g.requestedAt)}</span>
              {g.status === "pending" ? (
                <span className="flex gap-1.5">
                  <Button data-variant="solid" className="btn-sm" onClick={() => void act("Allowed", () => api.decide(g.gateId, "allowed"), done)}>Allow</Button>
                  <Button className="btn-sm" onClick={() => void act("Denied", () => api.decide(g.gateId, "denied"), done)}>Deny</Button>
                </span>
              ) : <span className="text-xs text-fd-muted-foreground">by {g.decisionBy ?? "operator"}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Vault() {
  const { data, refresh } = usePoll(api.vault, 8000);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(""); const [host, setHost] = useState(""); const [secret, setSecret] = useState("");

  async function add(e: FormEvent) {
    e.preventDefault();
    const r = await act("Credential stored", () => api.addVault({ name: name.trim(), host: host.trim(), secret }), () => void refresh());
    if (r !== undefined) { setOpen(false); setName(""); setHost(""); setSecret(""); }
  }
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-fd-border px-4 py-3">
        <div><h2 className="h-section">Credential vault</h2><p className="text-sm text-fd-muted-foreground">Keeps a masked reference only. The secret value is discarded, and injection into sandboxes is not wired up yet.</p></div>
        <Button onClick={() => setOpen(true)}><Plus className="size-4" aria-hidden="true" /><span>Add credential</span></Button>
      </div>
      {!data?.length ? <Empty title="No credentials" hint="Add a masked reference to an API key for one host." /> : (
        <ul className="divide-y divide-fd-border bg-fd-background">
          {data.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="font-mono text-xs font-medium">{v.name}</span><Badge mono>{v.host}</Badge>
              <span className="font-mono text-xs text-fd-muted-foreground">{v.maskedValue}</span>
              <IconButton className="ml-auto" label={`Delete ${v.name}`} onClick={() => void act("Credential deleted", () => api.delVault(v.id), () => void refresh())}><Trash2 className="size-3.5" aria-hidden="true" /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogBackdrop />
        <DialogContent className="w-[min(440px,92vw)] p-5">
          <form onSubmit={add} className="flex flex-col gap-4">
            <div data-slot="stack"><DialogTitle className="h-section">Add credential</DialogTitle><DialogDescription className="text-sm text-fd-muted-foreground">Only a masked reference is kept. The secret itself is not stored.</DialogDescription></div>
            <Field><FieldLabel>Name</FieldLabel><Input value={name} onValueChange={setName} placeholder="GITHUB_TOKEN" /></Field>
            <Field><FieldLabel>Host</FieldLabel><Input value={host} onValueChange={setHost} placeholder="api.github.com" /></Field>
            <Field><FieldLabel>Secret</FieldLabel><Input type="password" value={secret} onValueChange={setSecret} autoComplete="off" /></Field>
            <div data-slot="row"><DialogClose type="button">Cancel</DialogClose><Button type="submit" data-variant="solid" disabled={!name.trim() || !host.trim() || !secret}>Store</Button></div>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Workflows({ onChange }: { onChange: () => void }) {
  const { data, refresh } = usePoll(api.workflows, 4000);
  const [name, setName] = useState("");
  const done = () => { void refresh(); onChange(); };
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-fd-border px-4 py-3">
        <div><h2 className="h-section">Workflow slots</h2><p className="text-sm text-fd-muted-foreground">Up to {data?.maxConcurrency ?? 4} jobs run at once. The rest wait in the queue.</p></div>
        <Button onClick={() => void act("Pipeline flushed", api.flush, done)}>Flush pipeline</Button>
      </div>
      <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-4">
        {(data?.slots ?? []).map((s) => (
          <div key={s.slot} className={cx("rounded-lg border p-3 text-sm", s.status === "open" ? "border-dashed border-fd-border bg-fd-background" : "border-fd-border bg-fd-background")}>
            <div className="flex items-center justify-between"><span className="font-mono text-xs text-fd-muted-foreground">slot {s.slot}</span><Badge tone={s.status === "active" ? "ok" : s.status === "queued" ? "warn" : "neutral"}>{s.status}</Badge></div>
            <p className="mt-2 truncate font-medium">{s.jobName ?? "Idle"}</p><p className="truncate text-xs text-fd-muted-foreground">{s.stepText ?? "No job assigned"}</p>
          </div>
        ))}
      </div>
      <form className="flex gap-2 border-t border-fd-border bg-fd-background p-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void act("Job queued", () => api.enqueue(name.trim(), "Step 1/1"), () => { setName(""); done(); }); }}>
        <Input value={name} onValueChange={setName} placeholder="Job name, e.g. nightly_scan" aria-label="Job name" className="flex-1" />
        <Button type="submit" data-variant="solid" disabled={!name.trim()}>Enqueue</Button>
      </form>
    </Card>
  );
}

export function Security({ onChange }: { onChange: () => void }) {
  return (<><PageHeader title="Security" sub="Review outbound requests, manage secrets and control job concurrency." /><Egress onChange={onChange} /><Vault /><Workflows onChange={onChange} /></>);
}
