import { useEffect, useRef, useState } from "react";
import { Drawer, DrawerBackdrop, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle } from "@ui-sdk/react/drawer";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { X } from "lucide-react";
import { browserSocketUrl, type Sandbox } from "../api";
import { StatusBadge } from "../lib";

interface Frame { src: string; url?: string; at: number }

/** Pull the picture and the page address out of one message from the browser stream. */
function readFrame(raw: string): { frame?: Frame; status?: string; error?: string; url?: string } {
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  if (msg.type === "status") return { status: String(msg.text ?? "") };
  if (msg.type === "url" && typeof msg.url === "string") return { url: msg.url };
  // The tab list is sent on connect, so a viewer that joins late still learns the current page.
  if (Array.isArray(msg.tabs)) {
    const tab = (msg.tabs as Array<{ active?: boolean; url?: string }>).find((t) => t.active);
    if (tab?.url && tab.url !== "about:blank") return { url: tab.url };
  }
  if (msg.type === "error") return { error: String(msg.text ?? "The browser stream failed.") };
  if (msg.type === "frame" && typeof msg.data === "string") {
    const meta = (msg.metadata ?? {}) as Record<string, unknown>;
    return { frame: { src: `data:image/jpeg;base64,${msg.data}`, url: typeof meta.url === "string" ? meta.url : undefined, at: Date.now() } };
  }
  return {};
}

/** A live, view-only picture of the browser inside an agent's sandbox. */
export function BrowserView({ sandbox, onClose }: { sandbox: Sandbox | null; onClose: () => void }) {
  const id = sandbox?.id ?? "";
  const [frame, setFrame] = useState<Frame | null>(null);
  const [note, setNote] = useState("Connecting…");
  const [failed, setFailed] = useState(false);
  const [frames, setFrames] = useState(0);
  const [pageUrl, setPageUrl] = useState("");
  const [attempt, setAttempt] = useState(0);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!id) return;
    setFrame(null); setFrames(0); setPageUrl(""); setFailed(false); setNote("Connecting…");
    let closed = false;
    const ws = new WebSocket(browserSocketUrl(id));
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const r = readFrame(ev.data);
      if (r.frame) { setFrame(r.frame); setFrames((n) => n + 1); setNote(""); }
      if (r.url) setPageUrl(r.url);
      if (r.status) setNote(r.status);
      if (r.error) { setNote(r.error); setFailed(true); }
    };
    ws.onclose = () => {
      if (closed) return;
      // The stream drops when the agent's browser restarts. Try again, a few times.
      setNote((n) => n || "The stream closed. Reconnecting…");
      if (attempt < 5) retry.current = setTimeout(() => setAttempt((a) => a + 1), 2500);
      else setFailed(true);
    };
    return () => { closed = true; clearTimeout(retry.current); ws.close(); };
  }, [id, attempt]);

  useEffect(() => { setAttempt(0); }, [id]);

  return (
    <Drawer open={sandbox !== null} onOpenChange={(o) => { if (!o) onClose(); }} side="right">
      <DrawerBackdrop />
      <DrawerContent className="flex h-full w-[min(920px,100vw)] flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <div data-slot="stack" className="min-w-0">
            <DrawerTitle className="h-section truncate">Browser · {sandbox?.role ?? "Agent"}</DrawerTitle>
            <DrawerDescription className="truncate font-mono text-xs text-fd-muted-foreground">{pageUrl || frame?.url || sandbox?.id}</DrawerDescription>
          </div>
          <div className="flex items-center gap-2">
            {sandbox && <StatusBadge status={sandbox.status} />}
            <Tooltip delay={250}>
              <TooltipTrigger render={<DrawerClose aria-label="Close browser view" />}><X className="size-4" aria-hidden="true" /></TooltipTrigger>
              <TooltipContent side="bottom" className="rounded-md bg-fd-foreground px-2 py-1 text-xs font-medium text-white">Close</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-fd-border bg-fd-muted">
          {frame ? (
            <img src={frame.src} alt="Live view of the agent's browser" className="max-h-full max-w-full object-contain" />
          ) : (
            <div className="max-w-sm p-6 text-center">
              <p className={failed ? "text-sm font-medium text-fd-primary" : "text-sm font-medium"} role={failed ? "alert" : "status"}>{note}</p>
              <p className="mt-1 text-sm text-fd-muted-foreground">The agent opens its browser when a task needs a web page. This view is watch only.</p>
            </div>
          )}
        </div>
        <p className="text-xs text-fd-muted-foreground" aria-live="polite">
          {frame ? `Live · ${frames} frame${frames === 1 ? "" : "s"} received` : "Waiting for the first frame"}
        </p>
      </DrawerContent>
    </Drawer>
  );
}
