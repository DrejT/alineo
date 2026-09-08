"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Renders a Mermaid diagram. ` ```mermaid ` code fences in MDX are rewritten to
 * `<Mermaid chart="…" />` by `remarkMdxMermaid` (wired in `source.config.ts`).
 *
 * `mermaid` is a large dependency, so it's imported lazily on first render — fine
 * for a static export, where this only runs in the browser anyway.
 */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId();
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const renderedChart = useRef<string | null>(null);

  useEffect(() => {
    if (renderedChart.current === chart) return;
    renderedChart.current = chart;

    let cancelled = false;
    void (async () => {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        fontFamily: "var(--font-inter), ui-sans-serif, system-ui, sans-serif",
        theme: "base",
        themeVariables: {
          background: "#ffffff",
          primaryColor: "#faf0f5",
          primaryBorderColor: "#7a1b48",
          primaryTextColor: "#111111",
          lineColor: "#a1a1aa",
          secondaryColor: "#f4f4f5",
          tertiaryColor: "#fafafa",
        },
      });

      try {
        const { svg } = await mermaid.render(`mermaid-${id.replace(/[^a-zA-Z0-9]/g, "")}`, chart);
        if (!cancelled) setSvg(svg);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  if (error) {
    return (
      <pre className="text-fd-muted-foreground text-sm">
        <code>{chart}</code>
      </pre>
    );
  }

  return (
    <div
      className="my-6 flex justify-center [&_svg]:h-auto [&_svg]:max-w-full"
      // eslint-disable-next-line react/no-danger -- mermaid output, rendered client-side
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
