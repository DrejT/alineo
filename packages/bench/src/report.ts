import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RampResult } from "./load.ts";
import type { Manifest } from "./manifest.ts";

const f = (n: number | undefined) => (n === undefined || Number.isNaN(n) ? "-" : n.toFixed(0));

export function renderMarkdown(title: string, manifest: Manifest, res: RampResult): string {
  const lines = [`# ${title}`, ""];
  const h = manifest.host;
  lines.push(
    `Host: ${h.platform} (${h.release}), ${h.cpuModel}, ${h.cpus} threads, ${h.totalMemGiB} GiB RAM`,
    manifest.docker
      ? `Docker VM: ${manifest.docker.cpus} CPUs, ${manifest.docker.memGiB} GiB (server ${manifest.docker.serverVersion})`
      : "Docker VM: unavailable",
    `Commit: ${manifest.gitSha ?? "unknown"} - Run: ${manifest.runId}`,
    "",
  );
  const phaseNames = [...new Set(res.levels.flatMap((l) => Object.keys(l.phases)))];
  for (const phase of phaseNames) {
    lines.push(
      `## ${phase} (ms)`,
      "",
      "| N | ok | fail | p50 | p95 | p99 | max | wall |",
      "|---|---|---|---|---|---|---|---|",
    );
    for (const l of res.levels) {
      const s = l.phases[phase];
      lines.push(
        `| ${l.concurrency} | ${l.ok} | ${l.failed} | ${f(s?.p50)} | ${f(s?.p95)} | ${f(s?.p99)} | ${f(s?.max)} | ${f(l.wallMs)} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    `Last healthy level: ${res.lastHealthy ?? "none"}`,
    `First unhealthy level (knee): ${res.firstUnhealthy ?? "not reached"}`,
  );
  if (res.abortedBy) lines.push(`Aborted: ${res.abortedBy}`);
  const errs = res.levels.flatMap((l) =>
    Object.entries(l.errors).map(([m, c]) => `- N=${l.concurrency} x${c}: ${m}`),
  );
  if (errs.length) lines.push("", "## Errors", ...errs);
  return lines.join("\n") + "\n";
}

export function writeResults(
  dir: string,
  name: string,
  manifest: Manifest,
  res: RampResult,
): string {
  const out = join(dir, `${name}-${manifest.runId}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(out, "result.json"), JSON.stringify(res, null, 2));
  writeFileSync(join(out, "report.md"), renderMarkdown(name, manifest, res));
  return out;
}
