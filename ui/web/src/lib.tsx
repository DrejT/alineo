import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { createToaster } from "@ui-sdk/react/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { AuthError, clearToken } from "./api";

export const toast = createToaster();

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Some ledger events (workflow jobs) belong to no sandbox, so the id can be null. */
export const shortId = (id: string | null | undefined) => (!id ? "none" : id.length > 12 ? id.slice(0, 8) : id);

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "never";
  const d = Date.now() - ts;
  if (d < 10_000) return "just now";
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${Math.floor(d / 3_600_000)}h ago`;
}

export const clock = (ts: number) => new Date(ts).toTimeString().split(" ")[0];

/** Run an action, toast the outcome, and refresh. Session expiry sends the app back to sign-in. */
export async function act<T>(label: string, fn: () => Promise<T>, after?: () => void): Promise<T | undefined> {
  try {
    const r = await fn();
    toast.success(label);
    after?.();
    return r;
  } catch (e) {
    if (e instanceof AuthError) { clearToken(); window.location.reload(); return; }
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

/** Poll an async source. `refresh` reloads on demand; errors keep the last good data. */
export function usePoll<T>(fn: () => Promise<T>, ms: number | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const refresh = useCallback(async () => {
    try { setData(await fnRef.current()); setError(undefined); }
    catch (e) {
      if (e instanceof AuthError) { clearToken(); window.location.reload(); return; }
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    if (!ms) return;
    const t = setInterval(() => void refresh(), ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, refresh, ...deps]);
  return { data, error, refresh };
}

type Tone = "ok" | "warn" | "bad" | "info" | "neutral" | "brand";
const TONES: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok border-emerald-200",
  warn: "bg-warn-soft text-warn border-amber-200",
  bad: "bg-bad-soft text-bad border-rose-200",
  info: "bg-info-soft text-info border-sky-200",
  neutral: "bg-fd-muted text-fd-muted-foreground border-fd-border",
  brand: "bg-fd-primary-soft text-fd-primary border-fd-primary/20",
};

export function Badge({ tone = "neutral", children, mono }: { tone?: Tone; children: ReactNode; mono?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-[11px] font-medium leading-4", TONES[tone], mono && "font-mono")}>
      {children}
    </span>
  );
}

export const statusTone = (s: string): Tone => (s === "running" || s === "allowed" || s === "completed" ? "ok" : s === "paused" || s === "pending" || s === "queued" ? "warn" : s === "denied" || s === "failed" ? "bad" : "neutral");

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={statusTone(status)}>
      <span className={cx("size-1.5 rounded-full bg-current", status === "running" && "live-dot")} />
      {status}
    </Badge>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-xl border border-fd-border bg-fd-card", className)}>{children}</div>;
}

export function PageHeader({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="h-page">{title}</h1>
        {sub && <p className="mt-1 text-sm text-fd-muted-foreground">{sub}</p>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="mt-1 text-sm text-fd-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Icon-only button with a hover/focus label. The label is also the accessible name. */
export function IconButton({ label, children, onClick, disabled, destructive, className, side = "top" }: {
  label: string; children: ReactNode; onClick?: () => void; disabled?: boolean; destructive?: boolean; className?: string; side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <Tooltip delay={250}>
      <TooltipTrigger aria-label={label} onClick={onClick} disabled={disabled} data-variant={destructive ? "destructive" : undefined} className={className}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} className="rounded-md bg-fd-foreground px-2 py-1 text-xs font-medium text-white">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Catches a render error in one view so it cannot blank the whole app. Key it by view so that
 *  switching to another view starts clean. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("View crashed:", error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Card className="p-6">
        <h2 className="h-section">This view hit an error</h2>
        <p className="mt-1 text-sm text-fd-muted-foreground">The rest of the app is fine. Use the menu to go elsewhere, or try again.</p>
        <p className="mt-3 rounded-md bg-fd-muted p-3 font-mono text-xs">{this.state.error.message}</p>
        <button type="button" onClick={() => this.setState({ error: null })} className="mt-4 rounded-md border border-fd-border bg-fd-background px-3 py-1.5 text-sm font-medium hover:bg-fd-muted">Try again</button>
      </Card>
    );
  }
}
