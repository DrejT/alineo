#!/usr/bin/env bun
/**
 * One command for local platform development: alineod (HTTP+SSE API) and the dashboard
 * (Astro dev server) together, prefixed/colored output, one Ctrl-C tears both down.
 *
 * Does NOT start OpenSandbox itself — that's `alineo init` (Docker), a separate one-time step.
 * The dashboard's empty states explain how to run it when alineod can't be reached.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/** Bun's automatic `.env` loading only looks in a process's own cwd — the child processes below
 *  run from apps/alineod and apps/dashboard, not the repo root, so the root `.env` (model
 *  provider keys) would otherwise never reach them. Simple KEY=VALUE parse; good enough for the
 *  shape this repo's own `.env` actually uses. */
function loadRootEnv(): Record<string, string> {
  const vars: Record<string, string> = {};
  const path = join(root, ".env");
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at === -1) continue;
    vars[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return vars;
}

const rootEnv = loadRootEnv();

interface Proc {
  name: string;
  color: string;
  cwd: string;
  cmd: string[];
}

const PROCS: Proc[] = [
  { name: "alineod", color: "36", cwd: join(root, "apps/alineod"), cmd: ["bun", "--watch", "server.ts"] },
  { name: "dashboard", color: "35", cwd: join(root, "apps/dashboard"), cmd: ["bunx", "astro", "dev", "--port", "4321"] },
];

const children: ReturnType<typeof Bun.spawn>[] = [];

function prefix(name: string, color: string): string {
  return `\x1b[${color}m[${name}]\x1b[0m`;
}

async function pump(stream: ReadableStream<Uint8Array>, label: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) console.log(`${label} ${line}`);
  }
  if (buf) console.log(`${label} ${buf}`);
}

for (const p of PROCS) {
  const label = prefix(p.name, p.color);
  console.log(`${label} starting: ${p.cmd.join(" ")}`);
  const child = Bun.spawn(p.cmd, {
    cwd: p.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...rootEnv, ...process.env },
  });
  children.push(child);
  void pump(child.stdout as ReadableStream<Uint8Array>, label);
  void pump(child.stderr as ReadableStream<Uint8Array>, label);
}

function shutdown(): void {
  console.log("\nshutting down…");
  for (const child of children) child.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("alineod → http://localhost:4600   dashboard → http://localhost:4321");
console.log("(OpenSandbox itself is not started here — run `alineo init` first if it isn't up)");

await Promise.all(children.map((c) => c.exited));
