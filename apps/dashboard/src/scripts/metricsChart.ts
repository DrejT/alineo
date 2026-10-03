/** Ported from apps/sandbox/src/scripts/metricsChart.ts, with colors read from the design
 *  tokens (--color-accent / --color-ok) instead of hardcoded hex. */
import { wsUrl } from "../lib/api";

export interface MetricsHandle {
  resize(): void;
  dispose(): void;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function mountMetricsChart(
  canvas: HTMLCanvasElement,
  readout: HTMLElement,
  sandboxId: string,
): MetricsHandle {
  const ctx = canvas.getContext("2d")!;
  const cpuSamples: number[] = [];
  const memSamples: number[] = [];

  function resize() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width));
    canvas.height = Math.max(1, Math.floor(rect.height));
    draw();
  }

  function drawSeries(samples: number[], color: string) {
    if (samples.length < 2) return;
    const max = Math.max(...samples, 0.001);
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    samples.forEach((v, i) => {
      const x = (i / (samples.length - 1)) * canvas.width;
      const y = canvas.height - (v / max) * (canvas.height - 8) - 4;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawSeries(cpuSamples, cssVar("--color-accent") || "#7c5cff");
    drawSeries(memSamples, cssVar("--color-ok") || "#22c55e");
  }

  const ws = new WebSocket(wsUrl(`/sandboxes/${sandboxId}/metrics`));
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    // Real execd payload shape (see packages/opensandbox/src/types.ts's Metrics doc comment) —
    // cpu_used_pct is 0-100, mem_used_mib is MiB.
    const m = JSON.parse(ev.data) as {
      cpu_used_pct: number;
      mem_used_mib: number;
      mem_total_mib: number;
    };
    cpuSamples.push(m.cpu_used_pct);
    memSamples.push(m.mem_used_mib);
    if (cpuSamples.length > 120) cpuSamples.shift();
    if (memSamples.length > 120) memSamples.shift();
    readout.textContent = `cpu ${m.cpu_used_pct.toFixed(1)}% (accent)  ·  memory ${m.mem_used_mib.toFixed(0)} / ${m.mem_total_mib.toFixed(0)} MiB (ok)`;
    draw();
  });

  return { resize, dispose: () => ws.close() };
}
