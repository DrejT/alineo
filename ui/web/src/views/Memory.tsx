import { useState, type FormEvent } from "react";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Select, SelectContent, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@ui-sdk/react/select";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import { Trash2 } from "lucide-react";
import { api, type Sandbox } from "../api";
import { Badge, Card, Empty, IconButton, PageHeader, act, clock, shortId, usePoll } from "../lib";

const SCOPES = ["local", "subtree", "swarm"];

export function Memory({ list }: { list: Sandbox[] }) {
  const working = usePoll(api.working, 5000);
  const episodic = usePoll(api.episodic, 5000);
  const [query, setQuery] = useState("");
  const semantic = usePoll(() => api.semantic(query || undefined), null, [query]);
  const [sbId, setSbId] = useState("");
  const [scope, setScope] = useState("local");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const target = sbId || list[0]?.id || "";

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!target || !key.trim()) return;
    const r = await act("Saved to working memory", () => api.setWorking(target, key.trim(), value, scope), () => void working.refresh());
    if (r !== undefined) { setKey(""); setValue(""); }
  }

  return (
    <>
      <PageHeader title="Memory" sub="Working notes, decision history and facts your agents can recall.">
        <Button onClick={() => void act("Compaction finished", api.compact, () => { void working.refresh(); void episodic.refresh(); void semantic.refresh(); })}>Compact</Button>
      </PageHeader>
      <Tabs defaultValue="working">
        <TabsList aria-label="Memory type">
          <TabsTab value="working">Working</TabsTab>
          <TabsTab value="episodic">Episodic</TabsTab>
          <TabsTab value="semantic">Semantic</TabsTab>
        </TabsList>

        <TabsPanel value="working" className="flex flex-col gap-4">
          <Card className="p-4">
            {list.length === 0 ? <p className="text-sm text-fd-muted-foreground">Spawn a sandbox first. Working memory belongs to a sandbox.</p> : (
              <form onSubmit={add} className="grid items-end gap-3 sm:grid-cols-[1.2fr_1fr_1fr_1.4fr_auto]">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Select items={list.map((s) => ({ value: s.id, label: `${s.role} · ${shortId(s.id)}` }))} value={target} onValueChange={(v) => v && setSbId(v)}>
                    <SelectLabel>Sandbox</SelectLabel>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{list.map((s) => <SelectItem key={s.id} value={s.id}>{s.role} · {shortId(s.id)}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Select items={SCOPES} value={scope} onValueChange={(v) => v && setScope(v)}>
                    <SelectLabel>Scope</SelectLabel>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{SCOPES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <Field><FieldLabel>Key</FieldLabel><Input value={key} onValueChange={setKey} placeholder="target_pr" /></Field>
                <Field><FieldLabel>Value</FieldLabel><Input value={value} onValueChange={setValue} placeholder="418" /></Field>
                <Button type="submit" data-variant="solid" disabled={!key.trim()}>Save</Button>
              </form>
            )}
          </Card>
          <Card className="overflow-hidden">
            {!working.data?.length ? <Empty title="No working memory" hint="Key-value notes an agent keeps while it runs." /> : (
              <table className="w-full text-left text-sm">
                <thead className="border-b border-fd-border bg-fd-muted text-xs text-fd-muted-foreground"><tr>{["Sandbox", "Key", "Value", "Scope", "Updated", ""].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-fd-border bg-fd-background">
                  {working.data.map((m) => (
                    <tr key={m.id}>
                      <td className="px-4 py-2.5 font-mono text-xs text-fd-muted-foreground">{shortId(m.sandboxId)}</td>
                      <td className="px-4 py-2.5 font-mono text-xs font-medium">{m.key}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">{m.value}</td>
                      <td className="px-4 py-2.5"><Badge tone="brand" mono>{m.scope}</Badge></td>
                      <td className="px-4 py-2.5 text-xs text-fd-muted-foreground">{clock(m.updatedAt)}</td>
                      <td className="px-4 py-2.5 text-right"><IconButton label={`Delete ${m.key}`} onClick={() => void act("Deleted", () => api.delWorking(m.sandboxId, m.key), () => void working.refresh())}><Trash2 className="size-3.5" aria-hidden="true" /></IconButton></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </TabsPanel>

        <TabsPanel value="episodic">
          <Card className="overflow-hidden">
            {!episodic.data?.length ? <Empty title="No episodes yet" hint="Decisions and outcomes recorded by agents appear here." /> : (
              <ul className="divide-y divide-fd-border bg-fd-background">
                {episodic.data.map((e) => (
                  <li key={e.id} className="px-4 py-3 text-sm" style={{ paddingLeft: e.parentEpisodeId ? "2.25rem" : undefined }}>
                    <div className="flex flex-wrap items-center gap-2"><Badge tone="info" mono>{e.episodeType}</Badge><span className="font-medium">{e.title}</span><span className="ml-auto text-xs text-fd-muted-foreground">{clock(e.ts)}</span></div>
                    <p className="mt-1 text-fd-muted-foreground">{e.detail}</p>
                    {e.outcome && <p className="mt-1 text-xs"><span className="font-medium">Outcome:</span> {e.outcome}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsPanel>

        <TabsPanel value="semantic" className="flex flex-col gap-4">
          <Field><FieldLabel>Recall facts</FieldLabel><Input value={query} onValueChange={setQuery} placeholder="Search subject, predicate or object…" /></Field>
          <Card className="overflow-hidden">
            {!semantic.data?.length ? <Empty title={query ? "No matching facts" : "No facts yet"} hint="Subject, predicate and object triples with a confidence score." /> : (
              <ul className="divide-y divide-fd-border bg-fd-background">
                {semantic.data.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
                    <span className="font-mono text-xs font-medium">{f.subject}</span><span className="text-fd-muted-foreground">{f.predicate}</span><span className="font-mono text-xs">{f.object}</span>
                    <span className="ml-auto flex items-center gap-1.5">{f.tags.map((t) => <Badge key={t} mono>{t}</Badge>)}<Badge tone="ok" mono>{Math.round(f.confidence * 100)}%</Badge></span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsPanel>
      </Tabs>
    </>
  );
}
