"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Play, RotateCcw } from "lucide-react";

export interface PlaygroundCommand {
  /** The shell command as it would be typed. */
  command: string;
  /** Optional one-line note shown to the right of the command once typed. */
  note?: string;
}

export interface CookbookPlaygroundProps {
  /** Path shown in the terminal's title bar, e.g. "cookbooks/untrusted-code-execution". */
  cwd: string;
  /** Commands run in order. */
  commands: PlaygroundCommand[];
  /** The output produced once every command has "run". Rendered verbatim, ANSI-free. */
  output: string;
  /** Link to the real, runnable recipe in the repo. */
  repoHref: string;
}

type Phase = "idle" | "typing" | "running" | "done";

const TYPE_MS_PER_CHAR = 12;
const LINE_PAUSE_MS = 260;
const OUTPUT_REVEAL_MS = 6;

/**
 * A terminal-styled, click-to-play walkthrough of a cookbook's setup/run commands.
 *
 * This is a *simulated* replay, not a live sandbox — it types out the real commands from the
 * recipe and reveals the output you'd actually see, so you can preview the flow before running
 * it for real. It never executes anything.
 */
export function CookbookPlayground({ cwd, commands, output, repoHref }: CookbookPlaygroundProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [lineIndex, setLineIndex] = useState(0);
  const [typedInLine, setTypedInLine] = useState(0);
  const [outputShown, setOutputShown] = useState(0);
  const [copied, setCopied] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const reducedMotion = useRef(false);

  useEffect(() => {
    reducedMotion.current =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    return () => {
      for (const t of timers.current) clearTimeout(t);
    };
  }, []);

  const schedule = (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    timers.current.push(t);
  };

  const run = () => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
    setLineIndex(0);
    setTypedInLine(0);
    setOutputShown(0);

    if (reducedMotion.current) {
      setPhase("done");
      setLineIndex(commands.length);
      setOutputShown(output.length);
      return;
    }

    setPhase("typing");
    typeLine(0);
  };

  const typeLine = (line: number) => {
    if (line >= commands.length) {
      setPhase("running");
      schedule(() => revealOutput(0), LINE_PAUSE_MS);
      return;
    }
    const text = commands[line].command;
    const step = (char: number) => {
      setTypedInLine(char);
      if (char < text.length) {
        schedule(() => step(char + 1), TYPE_MS_PER_CHAR);
      } else {
        schedule(() => {
          setLineIndex(line + 1);
          setTypedInLine(0);
          typeLine(line + 1);
        }, LINE_PAUSE_MS);
      }
    };
    step(0);
  };

  const revealOutput = (pos: number) => {
    setOutputShown(pos);
    if (pos >= output.length) {
      setPhase("done");
      return;
    }
    // Reveal a few characters at a time — line-by-line feels choppy for long stdout blocks.
    const next = Math.min(pos + 3, output.length);
    schedule(() => revealOutput(next), OUTPUT_REVEAL_MS);
  };

  const reset = () => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
    setPhase("idle");
    setLineIndex(0);
    setTypedInLine(0);
    setOutputShown(0);
  };

  const copyCommands = async () => {
    const text = commands.map((c) => c.command).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      schedule(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable — silently ignore, the commands are still selectable text.
    }
  };

  const isIdle = phase === "idle";
  const showCursorOnLine = (i: number) =>
    (phase === "typing" && i === lineIndex) ||
    (isIdle && i === commands.length - 1) ||
    (phase !== "typing" && phase !== "idle" && i === commands.length - 1 && outputShown === 0);

  return (
    <div className="not-prose my-6 overflow-hidden rounded-xl border border-fd-border bg-[#0b0b0d] shadow-sm">
      <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.03] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full bg-[#ff5f57]" />
          <span className="size-2.5 rounded-full bg-[#febc2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
          <span className="ml-3 font-mono text-xs text-white/50">{cwd}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={copyCommands}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
          {isIdle ? (
            <button
              type="button"
              onClick={run}
              className="flex items-center gap-1.5 rounded-md bg-white/90 px-2.5 py-1 text-xs font-medium text-black transition-colors hover:bg-white"
            >
              <Play className="size-3.5 fill-current" />
              Run
            </button>
          ) : (
            <button
              type="button"
              onClick={reset}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-white/60 transition-colors hover:bg-white/10 hover:text-white"
            >
              <RotateCcw className="size-3.5" />
              Reset
            </button>
          )}
        </div>
      </div>

      <div className="max-h-[420px] overflow-auto px-4 py-4 font-mono text-[13px] leading-relaxed">
        {commands.map((c, i) => {
          const fullyTyped = phase === "idle" || i < lineIndex || phase === "done";
          const text = fullyTyped
            ? c.command
            : i === lineIndex
              ? c.command.slice(0, typedInLine)
              : "";
          if (!fullyTyped && i > lineIndex) return null;
          return (
            <div key={i} className="flex flex-wrap items-baseline gap-2">
              <span className="text-emerald-400">$</span>
              <span className="text-white/90">
                {text}
                {showCursorOnLine(i) && <span className="playground-cursor" aria-hidden />}
              </span>
              {fullyTyped && c.note && <span className="text-xs text-white/35">{c.note}</span>}
            </div>
          );
        })}

        {(phase === "running" || phase === "done") && (
          <pre aria-live="polite" className="mt-3 whitespace-pre-wrap text-white/60">
            {output.slice(0, outputShown)}
            {phase === "running" && <span className="playground-cursor" aria-hidden />}
          </pre>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-white/10 bg-white/[0.03] px-4 py-2 text-xs text-white/40">
        <span>Simulated preview — no sandbox is actually created here.</span>
        <a
          href={repoHref}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-white/60 underline decoration-white/20 underline-offset-2 hover:text-white"
        >
          Run it for real →
        </a>
      </div>

      <style>{`
        .playground-cursor {
          display: inline-block;
          width: 0.5em;
          height: 1em;
          margin-left: 1px;
          vertical-align: -0.15em;
          background: currentColor;
          opacity: 0.8;
          animation: playground-blink 1s step-end infinite;
        }
        @keyframes playground-blink {
          50% { opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .playground-cursor { animation: none; }
        }
      `}</style>
    </div>
  );
}
