import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@ui-sdk/react/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@ui-sdk/react/command";
import { Dialog, DialogBackdrop, DialogContent, DialogTitle } from "@ui-sdk/react/dialog";
import { Toast, ToastDescription, ToastRegion, ToastTitle } from "@ui-sdk/react/toast";
import { Bot, Boxes, Brain, LayoutDashboard, LogOut, Menu, Plug, Plus, ScrollText, Search, ShieldCheck, SquareTerminal, X } from "lucide-react";
import { api, clearToken, hasToken, type Sandbox } from "./api";
import { Badge, ErrorBoundary, IconButton, act, cx, toast, usePoll } from "./lib";
import { Login, Logo } from "./views/Login";
import { Overview } from "./views/Overview";
import { Sandboxes, SpawnDialog } from "./views/Sandboxes";
import { Agents } from "./views/Agents";
import { TerminalDrawer } from "./views/Terminal";
import { Ledger } from "./views/Ledger";
import { Memory } from "./views/Memory";
import { Security } from "./views/Security";
import { Runner } from "./views/Runner";
import { Mcp } from "./views/Mcp";

const SECTIONS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "sandboxes", label: "Sandboxes", icon: Boxes },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "ledger", label: "Audit ledger", icon: ScrollText },
  { id: "memory", label: "Memory", icon: Brain },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "runner", label: "Runner", icon: SquareTerminal },
  { id: "mcp", label: "MCP connector", icon: Plug },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

const fromHash = (): SectionId => {
  const h = window.location.hash.replace(/^#\/?/, "");
  return (SECTIONS.find((s) => s.id === h)?.id ?? "overview") as SectionId;
};

export function App() {
  const [authed, setAuthed] = useState(hasToken());
  return (
    <>
      {authed ? <Shell onSignOut={() => setAuthed(false)} /> : <Login onDone={() => setAuthed(true)} />}
      <ToastRegion toaster={toast}>
        {() => (
          <Toast>
            <div data-slot="stack">
              <ToastTitle />
              <ToastDescription />
            </div>
          </Toast>
        )}
      </ToastRegion>
    </>
  );
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const [section, setSection] = useState<SectionId>(fromHash);
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [spawnParent, setSpawnParent] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [termId, setTermId] = useState<string | null>(null);

  const status = usePoll(api.status, 3000);
  const sandboxes = usePoll(api.sandboxes, 3000);
  const list: Sandbox[] = sandboxes.data ?? [];
  const refresh = useCallback(() => { void status.refresh(); void sandboxes.refresh(); }, [status, sandboxes]);

  const go = useCallback((id: SectionId) => { window.location.hash = `/${id}`; setSection(id); setNavOpen(false); }, []);
  useEffect(() => {
    const onHash = () => setSection(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((o) => !o); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openSpawn = useCallback((parentId: string | null = null) => { setSpawnParent(parentId); setSpawnOpen(true); }, []);
  const selected = useMemo(() => list.find((s) => s.id === selectedId) ?? null, [list, selectedId]);
  const fleet = status.data?.fleet;
  const user = status.data?.user;
  const pending = fleet?.pendingGates ?? 0;

  async function signOut() {
    try { await api.logout(); } catch { /* token may already be invalid */ }
    clearToken();
    onSignOut();
  }

  const runCommand = (value: string) => {
    setPaletteOpen(false);
    if (value.startsWith("go:")) go(value.slice(3) as SectionId);
    else if (value === "spawn") openSpawn();
    else if (value === "refresh") { refresh(); toast("Refreshed"); }
    else if (value === "flush") void act("Pipeline flushed", api.flush, refresh);
    else if (value === "signout") void signOut();
  };

  const nav = (
    <nav aria-label="Sections" className="flex flex-col gap-0.5 p-3">
      {SECTIONS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => go(id)}
          aria-current={section === id ? "page" : undefined}
          className={cx(
            "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition-colors",
            section === id ? "bg-fd-primary-soft text-fd-primary" : "text-fd-muted-foreground hover:bg-fd-muted hover:text-fd-foreground",
          )}
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 truncate">{label}</span>
          {id === "sandboxes" && fleet && fleet.total > 0 && <span className="font-mono text-[11px] text-fd-muted-foreground">{fleet.total}</span>}
          {id === "security" && pending > 0 && <Badge tone="warn">{pending}</Badge>}
        </button>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-full">
      {navOpen && <div className="fixed inset-0 z-30 bg-black/20 lg:hidden" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <aside className={cx("fixed inset-y-0 left-0 z-40 flex w-[232px] flex-col justify-between border-r border-fd-border bg-fd-card transition-transform lg:translate-x-0", navOpen ? "translate-x-0" : "-translate-x-full")}>
        <div>
          <div className="flex h-14 items-center justify-between border-b border-fd-border px-4">
            <a href="#/overview" aria-label="alineo overview"><Logo /></a>
            <button type="button" className="rounded-lg p-1 text-fd-muted-foreground lg:hidden" onClick={() => setNavOpen(false)} aria-label="Close navigation"><X className="size-4" /></button>
          </div>
          {nav}
        </div>
        <div className="border-t border-fd-border p-3">
          <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-fd-primary text-xs font-semibold text-fd-primary-foreground">{(user?.username ?? "?").slice(0, 1).toUpperCase()}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user?.displayName ?? user?.username ?? "…"}</p>
              <p className="truncate font-mono text-[11px] text-fd-muted-foreground">{user?.username}</p>
            </div>
            <IconButton label="Sign out" side="right" onClick={() => void signOut()}><LogOut className="size-4" aria-hidden="true" /></IconButton>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:pl-[232px]">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-fd-border bg-fd-background/95 px-4 backdrop-blur sm:px-6">
          <button type="button" className="rounded-lg p-1.5 text-fd-muted-foreground lg:hidden" onClick={() => setNavOpen(true)} aria-label="Open navigation"><Menu className="size-5" /></button>
          <button type="button" onClick={() => setPaletteOpen(true)} className="flex h-9 w-full max-w-sm items-center gap-2 rounded-pill border border-fd-border bg-fd-card px-3 text-sm text-fd-muted-foreground hover:border-fd-accent">
            <Search className="size-4" aria-hidden="true" />
            <span className="flex-1 text-left">Search or run a command…</span>
            <kbd className="rounded border border-fd-border bg-fd-background px-1.5 font-mono text-[10px]">⌘K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden items-center gap-1.5 text-xs text-fd-muted-foreground sm:flex">
              <span className={cx("size-2 rounded-full", status.data?.daemon.online ? "live-dot bg-ok" : "bg-fd-accent")} />
              {status.error ? "Server unreachable" : status.data?.daemon.online ? "Daemon online" : "Daemon offline"}
              {fleet && <span className="font-mono">· {fleet.running}/{fleet.total} running</span>}
            </span>
            <Button data-variant="solid" onClick={() => openSpawn()}><Plus className="size-4" aria-hidden="true" /><span>Spawn sandbox</span></Button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1200px] flex-1 p-4 sm:p-6 lg:p-8">
          <ErrorBoundary key={section}>
          <Section show={section === "overview"}>
            <Overview status={status.data} list={list} selected={selected} onSelect={setSelectedId} onTerminal={setTermId} onChange={refresh} go={go} loading={sandboxes.data === undefined} />
          </Section>
          <Section show={section === "sandboxes"}>
            <Sandboxes list={list} onTerminal={setTermId} onChange={refresh} loading={sandboxes.data === undefined} />
          </Section>
          <Section show={section === "agents"}>
            <Agents list={list} onTerminal={setTermId} onChange={refresh} />
          </Section>
          <Section show={section === "ledger"}><Ledger /></Section>
          <Section show={section === "memory"}><Memory list={list} /></Section>
          <Section show={section === "security"}><Security onChange={refresh} /></Section>
          <Section show={section === "runner"}><Runner onChange={refresh} /></Section>
          <Section show={section === "mcp"}><Mcp /></Section>
          </ErrorBoundary>
        </main>
      </div>

      <SpawnDialog open={spawnOpen} onOpenChange={setSpawnOpen} list={list} parentId={spawnParent} onDone={(sb) => { refresh(); setSelectedId(sb.id); }} />
      <TerminalDrawer sandbox={list.find((s) => s.id === termId) ?? null} onClose={() => setTermId(null)} onChange={refresh} />

      <Dialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <DialogBackdrop />
        <DialogContent aria-label="Command palette" className="w-[min(560px,92vw)] p-0">
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <Command onAction={runCommand}>
            <div className="border-b border-fd-border p-2"><CommandInput aria-label="Search commands" placeholder="Type a command or search…" /></div>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandList className="max-h-80 overflow-auto p-1">
              {SECTIONS.map((s) => <CommandItem key={s.id} value={`go:${s.id}`} keywords={[s.label, "go", "open"]}>Go to {s.label}</CommandItem>)}
              <CommandItem value="spawn" keywords={["new", "create", "sandbox"]}>Spawn sandbox</CommandItem>
              <CommandItem value="flush" keywords={["workflow", "pipeline"]}>Flush workflow pipeline</CommandItem>
              <CommandItem value="refresh">Refresh data</CommandItem>
              <CommandItem value="signout" keywords={["logout"]}>Sign out</CommandItem>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Section({ show, children }: { show: boolean; children: ReactNode }) {
  return <div hidden={!show} className="flex flex-col gap-6">{show ? children : null}</div>;
}
