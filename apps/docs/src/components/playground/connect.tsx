"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Plug, RefreshCw, X } from "lucide-react";
import { useConnection, type ConnectionStatus } from "@/lib/playground/connection";
import { HOSTED_ENDPOINT, LOCAL_ENDPOINT } from "@/lib/playground/client";

function Dot({ status }: { status: ConnectionStatus }) {
  const color =
    status === "online"
      ? "bg-emerald-500"
      : status === "checking"
        ? "bg-amber-500"
        : status === "offline"
          ? "bg-rose-500"
          : "bg-fd-muted-foreground";
  return (
    <span className="relative flex size-2.5">
      {status === "checking" && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-75" />
      )}
      <span className={`relative inline-flex size-2.5 rounded-full ${color}`} />
    </span>
  );
}

function statusText(status: ConnectionStatus, base: string): string {
  switch (status) {
    case "online":
      return `Connected to ${base}`;
    case "checking":
      return `Checking ${base}…`;
    case "offline":
      return `Can't reach ${base}`;
    default:
      return "Not connected";
  }
}

/** Compact one-line status + reconnect, shown at the top of every WorkflowRunner. */
export function ConnectionStrip() {
  const { endpoint, status, capacity, refresh } = useConnection();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-fd-border bg-fd-background px-3 py-2">
      <div className="flex items-center gap-2 text-[12.5px]">
        <Dot status={status} />
        <span className="min-w-0 flex-1 truncate text-fd-muted-foreground">
          {statusText(status, endpoint)}
        </span>
        {capacity && status === "online" && (
          <span className="shrink-0 font-mono text-[11px] text-fd-muted-foreground">
            {capacity.sandboxes.used}/{capacity.sandboxes.max} sandboxes
          </span>
        )}
        <button
          type="button"
          onClick={() => refresh()}
          className="shrink-0 rounded p-1 text-fd-muted-foreground transition-colors hover:bg-fd-card hover:text-fd-foreground"
          aria-label="Recheck connection"
        >
          <RefreshCw className={`size-3.5 ${status === "checking" ? "animate-spin" : ""}`} />
        </button>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="shrink-0 rounded px-1.5 py-1 text-[11px] font-medium text-fd-muted-foreground transition-colors hover:bg-fd-card hover:text-fd-foreground"
        >
          {expanded ? "Hide" : "Change"}
        </button>
      </div>
      {expanded && <EndpointEditor onDone={() => setExpanded(false)} />}
    </div>
  );
}

function EndpointEditor({ onDone }: { onDone?: () => void }) {
  const { endpoint, setEndpoint, resetEndpoint, refresh } = useConnection();
  const [draft, setDraft] = useState(endpoint);

  useEffect(() => setDraft(endpoint), [endpoint]);

  const apply = (value: string) => {
    setEndpoint(value);
    // refresh() re-runs off the new client via the provider effect; nudge it too.
    setTimeout(() => void refresh(), 0);
    onDone?.();
  };

  return (
    <div className="flex flex-col gap-2 border-t border-fd-border pt-2">
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => apply(HOSTED_ENDPOINT)}
          className="rounded-md border border-fd-border px-2 py-1 text-[11px] font-medium text-fd-muted-foreground transition-colors hover:border-fd-primary hover:text-fd-foreground"
        >
          Hosted ({HOSTED_ENDPOINT.replace("https://", "")})
        </button>
        <button
          type="button"
          onClick={() => apply(LOCAL_ENDPOINT)}
          className="rounded-md border border-fd-border px-2 py-1 text-[11px] font-medium text-fd-muted-foreground transition-colors hover:border-fd-primary hover:text-fd-foreground"
        >
          Local ({LOCAL_ENDPOINT.replace("http://", "")})
        </button>
      </div>
      <div className="flex gap-1.5">
        <input
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply(draft)}
          placeholder="https://sandbox-api.alineo.tech"
          className="min-w-0 flex-1 rounded-md border border-fd-border bg-fd-card px-2 py-1 font-mono text-[12px] text-fd-foreground outline-none focus:border-fd-primary"
        />
        <button
          type="button"
          onClick={() => apply(draft)}
          className="inline-flex items-center gap-1 rounded-md bg-fd-primary px-2 py-1 text-[11px] font-medium text-fd-primary-foreground hover:opacity-90"
        >
          <Check className="size-3" />
          Use
        </button>
        <button
          type="button"
          onClick={() => {
            resetEndpoint();
            setTimeout(() => void refresh(), 0);
          }}
          className="rounded-md border border-fd-border px-2 py-1 text-[11px] text-fd-muted-foreground hover:text-fd-foreground"
        >
          <X className="size-3" />
        </button>
      </div>
    </div>
  );
}

/** Full connection panel for the playground overview page. */
export function PlaygroundConnect() {
  const { endpoint, status, capacity, error, refresh } = useConnection();

  return (
    <div className="not-prose my-6 flex flex-col gap-3 rounded-xl border border-fd-border bg-fd-card p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Plug className="size-4 text-fd-primary" />
        <span className="text-[13px] font-semibold text-fd-foreground">Sandbox server</span>
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-fd-muted-foreground">
          {status === "checking" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Dot status={status} />
          )}
          {status === "online"
            ? "online"
            : status === "checking"
              ? "checking"
              : status === "offline"
                ? "offline"
                : "idle"}
        </span>
      </div>

      <p className="text-[13px] text-fd-muted-foreground">
        Every workflow in this section runs against a real{" "}
        <a href="https://open-sandbox.ai" className="text-fd-primary underline decoration-fd-border">
          OpenSandbox
        </a>{" "}
        instance through the{" "}
        <a
          href="https://github.com/DrejT/alineo/tree/main/apps/sandbox"
          className="text-fd-primary underline decoration-fd-border"
        >
          alineo sandbox API
        </a>
        . Point it at the hosted endpoint, or at your own local server from{" "}
        <code>bunx alineo-cli init</code>.
      </p>

      <EndpointEditor />

      <div className="flex items-center justify-between gap-2 border-t border-fd-border pt-3 text-[12px]">
        <span className="text-fd-muted-foreground">
          {status === "online" && capacity ? (
            <>
              {capacity.sandboxes.used}/{capacity.sandboxes.max} sandboxes ·{" "}
              {capacity.agents.used}/{capacity.agents.max} agents in use
            </>
          ) : error ? (
            <span className="text-rose-600 dark:text-rose-400">{error}</span>
          ) : (
            "—"
          )}
        </span>
        <button
          type="button"
          onClick={() => refresh()}
          className="inline-flex items-center gap-1.5 rounded-md border border-fd-border px-2.5 py-1 font-medium text-fd-foreground transition-colors hover:bg-fd-background"
        >
          <RefreshCw className={`size-3.5 ${status === "checking" ? "animate-spin" : ""}`} />
          Recheck
        </button>
      </div>
      <p className="text-[11.5px] text-fd-muted-foreground">
        Endpoint {endpoint} · hard-capped at {capacity?.sandboxes.max ?? 3} sandboxes, auto-expiring.
        Runs are cleaned up when they finish.
      </p>
    </div>
  );
}
