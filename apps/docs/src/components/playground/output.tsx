"use client";

import { useEffect, useRef } from "react";

/** A dark, monospace, auto-scrolling output pane for streamed command / agent output. */
export function OutputPane({ text, label }: { text: string; label?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className="not-prose overflow-hidden rounded-lg border border-fd-border bg-[#0b0b0d]">
      {label && (
        <div className="border-b border-white/10 bg-white/[0.03] px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-white/40">
          {label}
        </div>
      )}
      <pre
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        aria-live="polite"
        className="max-h-[360px] overflow-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-white/80"
      >
        {text || <span className="text-white/30">— no output yet —</span>}
      </pre>
    </div>
  );
}
