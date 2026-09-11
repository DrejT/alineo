"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, CircleAlert, Loader2, Play, RotateCcw, Square } from "lucide-react";
import { useConnection } from "@/lib/playground/connection";
import { getWorkflow, type StepRuntime } from "@/lib/playground/workflows";
import { OutputPane } from "./output";
import { ConnectionStrip } from "./connect";

type StepStatus = "pending" | "running" | "done" | "error";

interface StepView {
  status: StepStatus;
  output: string;
  error?: string;
}

type Phase = "idle" | "running" | "done" | "error" | "aborted";

export function WorkflowRunner({ workflow: slug }: { workflow: string }) {
  const wf = getWorkflow(slug);
  const { client, status } = useConnection();

  const [phase, setPhase] = useState<Phase>("idle");
  const [views, setViews] = useState<StepView[]>([]);
  const [current, setCurrent] = useState(-1);
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries((wf?.inputs ?? []).map((i) => [i.key, i.value])),
  );

  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef<Record<string, unknown>>({});
  const buffersRef = useRef<string[]>([]);
  const rafRef = useRef<number | null>(null);

  const stepCount = wf?.steps.length ?? 0;

  const flush = useCallback(() => {
    rafRef.current = null;
    setViews((prev) => prev.map((v, i) => ({ ...v, output: buffersRef.current[i] ?? "" })));
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(flush);
  }, [flush]);

  const cleanup = useCallback(async () => {
    const ids = (stateRef.current.__cleanup as string[] | undefined) ?? [];
    stateRef.current.__cleanup = [];
    await Promise.all(
      ids.map((id) => client.deleteSandbox(id).catch(() => client.deleteAgent(id).catch(() => {}))),
    );
  }, [client]);

  // Best-effort teardown if the reader navigates away mid-run.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      void cleanup();
    };
  }, [cleanup]);

  const reset = useCallback(() => {
    if (phase === "running") return;
    setPhase("idle");
    setCurrent(-1);
    setViews(wf ? wf.steps.map(() => ({ status: "pending", output: "" })) : []);
    buffersRef.current = wf ? wf.steps.map(() => "") : [];
    stateRef.current = {};
  }, [phase, wf]);

  useEffect(() => {
    setViews(wf ? wf.steps.map(() => ({ status: "pending", output: "" })) : []);
    buffersRef.current = wf ? wf.steps.map(() => "") : [];
  }, [wf]);

  const runAll = useCallback(async () => {
    if (!wf || phase === "running" || status !== "online") return;

    const ac = new AbortController();
    abortRef.current = ac;
    stateRef.current = {};
    buffersRef.current = wf.steps.map(() => "");
    setViews(wf.steps.map(() => ({ status: "pending", output: "" })));
    setPhase("running");

    let failed = false;
    for (let i = 0; i < wf.steps.length; i++) {
      if (ac.signal.aborted) break;
      setCurrent(i);
      setViews((prev) => prev.map((v, idx) => (idx === i ? { ...v, status: "running" } : v)));

      const rt: StepRuntime = {
        client,
        state: stateRef.current,
        input: inputs,
        signal: ac.signal,
        log: (text: string) => {
          buffersRef.current[i] = (buffersRef.current[i] ?? "") + text;
          scheduleFlush();
        },
      };

      try {
        await wf.steps[i].run(rt);
        flush();
        setViews((prev) => prev.map((v, idx) => (idx === i ? { ...v, status: "done" } : v)));
      } catch (err) {
        failed = true;
        const message = err instanceof Error ? err.message : String(err);
        flush();
        setViews((prev) =>
          prev.map((v, idx) => (idx === i ? { ...v, status: "error", error: message } : v)),
        );
        break;
      }
    }

    const aborted = ac.signal.aborted;
    await cleanup();
    setCurrent(-1);
    setPhase(aborted ? "aborted" : failed ? "error" : "done");
    abortRef.current = null;
  }, [wf, phase, status, client, inputs, scheduleFlush, flush, cleanup]);

  const primitives = useMemo(() => wf?.primitives ?? [], [wf]);

  if (!wf) {
    return (
      <div className="not-prose rounded-lg border border-fd-border bg-fd-card p-4 text-sm text-fd-muted-foreground">
        Unknown workflow: <code>{slug}</code>
      </div>
    );
  }

  const canRun = status === "online" && phase !== "running";

  return (
    <div className="not-prose my-6 flex flex-col gap-4 rounded-xl border border-fd-border bg-fd-card p-4 shadow-sm">
      <ConnectionStrip />

      {wf.needsModelKey && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-300">
          This workflow loads a Pi agent, which needs a model API key on the backend. The hosted
          endpoint has one configured; a local server needs <code>GEMINI_API_KEY</code> in its
          environment.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {primitives.map((p) => (
          <span
            key={p}
            className="rounded-full border border-fd-border bg-fd-background px-2 py-0.5 font-mono text-[11px] text-fd-muted-foreground"
          >
            {p}
          </span>
        ))}
        <span className="ml-auto text-[11px] text-fd-muted-foreground">{wf.estimate}</span>
      </div>

      {wf.inputs?.map((input) => (
        <label key={input.key} className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fd-muted-foreground">{input.label}</span>
          <textarea
            spellCheck={false}
            value={inputs[input.key] ?? ""}
            disabled={phase === "running"}
            onChange={(e) => setInputs((prev) => ({ ...prev, [input.key]: e.target.value }))}
            rows={Math.min(14, (inputs[input.key] ?? "").split("\n").length + 1)}
            className="w-full resize-y rounded-lg border border-fd-border bg-[#0b0b0d] px-3 py-2 font-mono text-[12.5px] leading-relaxed text-white/85 outline-none focus:border-fd-primary disabled:opacity-60"
          />
        </label>
      ))}

      <div className="flex items-center gap-2">
        {phase !== "running" ? (
          <button
            type="button"
            onClick={runAll}
            disabled={!canRun}
            className="inline-flex items-center gap-1.5 rounded-md bg-fd-primary px-3 py-1.5 text-[13px] font-medium text-fd-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Play className="size-3.5 fill-current" />
            {phase === "idle" ? "Run workflow" : "Run again"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            className="inline-flex items-center gap-1.5 rounded-md border border-fd-border px-3 py-1.5 text-[13px] font-medium text-fd-foreground transition-colors hover:bg-fd-background"
          >
            <Square className="size-3.5 fill-current" />
            Stop
          </button>
        )}
        {phase !== "idle" && phase !== "running" && (
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] text-fd-muted-foreground transition-colors hover:bg-fd-background hover:text-fd-foreground"
          >
            <RotateCcw className="size-3.5" />
            Reset
          </button>
        )}
        {status !== "online" && (
          <span className="text-[12px] text-fd-muted-foreground">
            Connect to a sandbox server above to run this.
          </span>
        )}
        <StatusLabel
          phase={phase}
          done={views.filter((v) => v.status === "done").length}
          total={stepCount}
        />
      </div>

      <ol className="flex flex-col gap-2">
        {wf.steps.map((step, i) => (
          <StepRow
            key={step.id}
            index={i}
            title={step.title}
            detail={step.detail}
            view={views[i] ?? { status: "pending", output: "" }}
            active={current === i}
          />
        ))}
      </ol>
    </div>
  );
}

function StatusLabel({ phase, done, total }: { phase: Phase; done: number; total: number }) {
  if (phase === "idle") return null;
  const map: Record<Exclude<Phase, "idle">, string> = {
    running: `Running — ${done}/${total} steps`,
    done: `Done — ${done}/${total} steps`,
    error: `Failed at step ${done + 1} of ${total}`,
    aborted: "Stopped",
  };
  const tone =
    phase === "done"
      ? "text-emerald-600 dark:text-emerald-400"
      : phase === "error"
        ? "text-rose-600 dark:text-rose-400"
        : "text-fd-muted-foreground";
  return <span className={`ml-auto text-[12px] font-medium ${tone}`}>{map[phase]}</span>;
}

function StepRow({
  index,
  title,
  detail,
  view,
  active,
}: {
  index: number;
  title: string;
  detail: string;
  view: StepView;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasOutput = view.output.length > 0 || !!view.error;

  useEffect(() => {
    if (active || view.status === "error") setOpen(true);
  }, [active, view.status]);

  return (
    <li
      className={`rounded-lg border transition-colors ${
        active ? "border-fd-primary/60 bg-fd-background" : "border-fd-border bg-fd-background/60"
      }`}
    >
      <button
        type="button"
        onClick={() => hasOutput && setOpen((o) => !o)}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left"
      >
        <StepIcon status={view.status} index={index} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-medium text-fd-foreground">{title}</span>
          <span className="block text-[12.5px] text-fd-muted-foreground">{detail}</span>
          {view.error && (
            <span className="mt-1 block font-mono text-[12px] text-rose-600 dark:text-rose-400">
              {view.error}
            </span>
          )}
        </span>
        {hasOutput && (
          <ChevronRight
            className={`mt-0.5 size-4 shrink-0 text-fd-muted-foreground transition-transform ${
              open ? "rotate-90" : ""
            }`}
          />
        )}
      </button>
      {open && hasOutput && (
        <div className="px-3 pb-3">
          <OutputPane text={view.output} />
        </div>
      )}
    </li>
  );
}

function StepIcon({ status, index }: { status: StepStatus; index: number }) {
  const base = "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]";
  if (status === "running")
    return (
      <span className={`${base} bg-fd-primary/10 text-fd-primary`}>
        <Loader2 className="size-3.5 animate-spin" />
      </span>
    );
  if (status === "done")
    return (
      <span className={`${base} bg-emerald-500/15 text-emerald-600 dark:text-emerald-400`}>
        <Check className="size-3.5" />
      </span>
    );
  if (status === "error")
    return (
      <span className={`${base} bg-rose-500/15 text-rose-600 dark:text-rose-400`}>
        <CircleAlert className="size-3.5" />
      </span>
    );
  return (
    <span className={`${base} border border-fd-border text-fd-muted-foreground`}>{index + 1}</span>
  );
}
