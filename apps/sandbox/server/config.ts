/**
 * Hardcoded, non-negotiable resource governance for the public, unauthenticated dashboard.
 * Nothing here is ever accepted as a client-supplied request field — see plans/sandbox-dashboard.md
 * ("Hard limits") for why.
 */

// 127.0.0.1, not "localhost" — some hosts resolve "localhost" to ::1 first, and
// OpenSandbox (and its proxied execd endpoints, via eip) only listen on IPv4.
export const OPENSANDBOX_URL = process.env.OPENSANDBOX_URL ?? "http://127.0.0.1:8080";
export const OPENSANDBOX_API_KEY = process.env.OPENSANDBOX_API_KEY ?? "";
export const USE_SERVER_PROXY = true;
export const LEDGER_PATH = process.env.LEDGER_PATH ?? "./data/ledger.db";

export const MAX_SANDBOXES = 3;
export const SANDBOX_IMAGE = "node:22";
export const SANDBOX_RESOURCES = { cpu: "250m", memory: "500Mi" };
/** Safety-net auto-expiry (seconds) in case a sandbox is left open indefinitely. */
export const SANDBOX_TIMEOUT_SECONDS = 60 * 60 * 4;
/** Wall-clock cap on a single `POST /api/sandboxes/:id/exec` command. */
export const EXEC_TIMEOUT_MS = 120_000;

/**
 * `POST /api/sandboxes/:id/exec` is public and unauthenticated — it exists only to back
 * the docs playground's guided workflows, every one of which runs a fixed, hardcoded
 * command (never anything built from reader input; the editable snippet/fix/task fields
 * go through `writeFile`/the agent prompt, not this route). So rather than trust whatever
 * `command` a caller sends, only ever run one of these exact strings.
 *
 * Sourced verbatim from apps/docs/src/lib/playground/workflows.ts — keep the two in sync:
 * a new playground step needs its exact command added here too, or its exec calls 403.
 */
export const ALLOWED_EXEC_COMMANDS: ReadonlySet<string> = new Set([
  // run-untrusted-code
  "mkdir -p /work",
  "cd /work && timeout 20 python3 snippet.py",
  "echo hostname=$(cat /etc/hostname); echo user=$(whoami); echo '--- / ---'; ls -1 /",
  // ci-test-runner
  "mkdir -p /proj",
  "cd /proj && node --test sum.test.js 2>&1 || true",
  // checkpoint-and-resume
  "mkdir -p /data && echo ready",
  `node -e "const fs=require('fs');const w=fs.createWriteStream('/data/raw.jsonl');for(let i=0;i<5000;i++)w.write(JSON.stringify({id:i,v:Math.floor(Math.random()*1000)})+'\\n');w.end();" && wc -l /data/raw.jsonl`,
  `node -e "const fs=require('fs');const rows=fs.readFileSync('/data/raw.jsonl','utf8').trim().split('\\n').map(JSON.parse);const b={};for(const r of rows){const k=Math.floor(r.v/100);b[k]=(b[k]||0)+1;}fs.writeFileSync('/data/agg.json',JSON.stringify(b,null,2));" && cat /data/agg.json`,
  "cp /data/agg.json /data/loaded.json && echo 'loaded at' $(date -u +%FT%TZ) | tee /data/DONE",
  // fork-a-sandbox
  "mkdir -p /work && echo 'shared baseline built once' > /work/base.txt && sleep 1 && cat /work/base.txt",
  "echo 'A was here' >> /work/base.txt && cat /work/base.txt",
  "echo 'B was here' >> /work/base.txt && cat /work/base.txt",
  "cat /work/base.txt",
  // agent-bugfix (verify step — the seed step uses writeFile, not exec)
  "cd /work && python3 test_fib.py 2>&1 || true",
  `cd /work && python3 -c "from fib import fib; print('fib(15) =', fib(15))"`,
]);

export const MAX_AGENTS = 2;
export const AGENTS_DIR = "./agents";
/** The only spec names `POST /api/agents` will accept — never an arbitrary URL or spec body. */
export const ALLOWED_AGENT_SPECS = ["hello-agent", "python-data"] as const;
export type AllowedAgentSpec = (typeof ALLOWED_AGENT_SPECS)[number];

export const PORT = Number(process.env.PORT ?? 3000);

/**
 * Origins allowed to call this API from a browser. The dashboard frontend and the
 * docs-site playground are each deployed separately (Cloudflare Pages, different
 * origins from this API), so CORS is required — `cors()` reflects the request's
 * `Origin` back only when it appears here. Extra origins (a preview deploy, a
 * different local dev port) can be added via `ALLOWED_ORIGINS` (comma-separated).
 */
export const ALLOWED_ORIGINS: readonly string[] = [
  "https://sandbox.alineo.tech",
  "https://docs.alineo.tech",
  // Local dev. This server usually owns :3000, so a local `next dev` for the docs
  // lands on :3001+; `astro dev` for the dashboard defaults to :4321.
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:4321",
  ...(process.env.ALLOWED_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean) ?? []),
  ...(process.env.ALLOWED_ORIGIN ? [process.env.ALLOWED_ORIGIN.trim()] : []),
];
